/**
 * Idle warming: keep an idle session's hour-long cache entry alive by
 * sending its last request again, a token at a time, for up to four
 * hours, so coming back reads the conversation from the cache rather
 * than writing all of it again.
 *
 * What is sent: the last request the session's own agent loop made,
 * byte for byte, as `before_provider_request` saw it, with
 * `max_tokens: 1`, and the headers `before_provider_headers` assembled
 * for it. A turn's requests are told from the rest by pi's `context`
 * event, which fires before each agent-loop call and never before a
 * summary, a cache warm of pi's own or a side call. It goes out through
 * `ctx.modelRegistry.streamSimple`, pi's own model runtime, which
 * resolves the model's base URL and credentials the way the turn did,
 * so the replay reaches the same endpoint and the same cache, and
 * credentials never pass through here. The headers are held in memory,
 * and written down across a restart only without any that could hold a
 * credential (see below). The reply joins nothing: it is not a message, only
 * a custom entry recording what it cost.
 *
 * When: once the run settles, at 54 minutes after the last real
 * request (nine tenths of the hour, `warmingDelayMs`), then 54 minutes
 * after each warm, at most four times (`MAX_IDLE_WARMS`). A timer that
 * runs so late that the entry has probably expired gives up rather
 * than paying for a full write (`warmDeadline`); a failed warm is tried
 * once more if its deadline allows.
 *
 * What stops it: anything real. A typed prompt, a run starting for any
 * reason, a compaction (under way when a warm falls due, since pi then
 * counts the session as busy, or landed), a model or thinking change,
 * moving in the session tree, a shutdown, the session ending, a new
 * request replacing the one held, or the package config switching it
 * off (`compaction.warmWhileIdle: false`).
 *
 * A reload is not real work: an install move reloads every idle
 * session, and ending its warming there left the next wake to write
 * the whole conversation to the cache again. The warming, or its end,
 * is carried in memory across the reload, keyed by the session, and the
 * reloaded extension takes it up when `resume` is called, with its
 * warms so far counted toward the four. If the reload changed what the
 * next request will send, the old entry is still warm, so a carried warm
 * reads it for a few cents rather than writing anything.
 *
 * A restart is not real work either: a pi host restarts itself when the
 * install moves, and a session parks after an hour idle. On any other
 * shutdown the same carry is written to disk by the kept requests'
 * rules (`lib/internal/warming-carry.ts`), with no header that could
 * hold a credential, and the next start of the session takes it back,
 * once, while the entry it warmed can still be warm. A pi host warms a
 * parked session's carry on (`host/engine/parked-warming.ts`), keeping
 * each warm it sends for that next start to record here.
 * `PI_COMPACTION_KEEP_REQUEST=off` keeps nothing on disk.
 *
 * After the fact, a warm that wrote more than 2,000 tokens to the cache
 * did not find its prefix there: warming that session stops and a
 * custom entry says why.
 *
 * Every warm is a custom entry carrying its model, usage and cost, the
 * shape the spend ledger reads as a side call, so `spend` counts it.
 *
 * Only an hour's entry is warmed. pi warms five-minute entries itself,
 * weighing each warm against the odds of a reply, and stops thirty
 * minutes after the last request, which for an hour's entry is before
 * its first warm would fall due.
 */

import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	cacheLifetimeOf,
	LONG_CACHE_LIFETIME_MS,
	MAX_IDLE_WARMS,
	PREFIX_MISS_WRITE_TOKENS,
	prefixMissed,
	replayable,
	warmDeadline,
	warmingDelayMs,
	warmingPayload,
} from "../../lib/internal/cache-warming.ts";
import {
	getSection,
	loadPackageConfig,
	type SectionParse,
} from "../../lib/internal/config/loader.ts";
import { processGlobal } from "../../lib/internal/process-global.ts";
import { isRecord } from "../../lib/internal/record.ts";
import { scrubSecrets } from "../../lib/internal/secrets.ts";
import { isStaleContext } from "../../lib/internal/stale.ts";
import {
	pendingWarmsDir,
	sweepPendingWarms,
	takePendingWarms,
	takeWarmingCarry,
	type WarmingCarry,
	warmingCarryDir,
	writeWarmingCarry,
} from "../../lib/internal/warming-carry.ts";
import { keepingRequests, sweepKeptRequests } from "./kept-request.ts";

/** A warm, with its usage and cost, for the spend ledger to count. */
export const WARM_ENTRY = "compaction-cache-warm";

/** Warming stopped for a reason somebody reading the log should see. */
export const WARM_STOPPED_ENTRY = "compaction-cache-warm-stopped";

/** The package config section, and its key that switches warming off. */
export const CONFIG_SECTION = "compaction";
export const WARM_KEY = "warmWhileIdle";

/** Modes whose sessions sit idle between runs; a subagent ends with its run. */
const IDLE_MODES: ReadonlySet<string> = new Set(["tui", "rpc"]);

/** A failed warm is tried once more after this, if its deadline allows. */
const RETRY_AFTER_MS = 30_000;

/** What a warm sends, captured from the turn that last sent it. */
interface HeldRequest {
	readonly payload: unknown;
	readonly headers: Record<string, string | null>;
	readonly model: Model<Api>;
	readonly at: number;
}

/** A warming under way, from the run's settling to its end. */
interface Run {
	readonly ctx: ExtensionContext;
	readonly held: HeldRequest;
	readonly lifetimeMs: number;
	readonly delayMs: number;
	readonly controller: AbortController;
	timer?: ReturnType<typeof setTimeout>;
	warms: number;
	retried: boolean;
	/** When the entry was last read or written, by a turn or a warm. */
	refreshedAt: number;
	/** When the next warm falls due, for the status line. */
	dueAt: number;
}

/** Ways for the rest of the workflow to follow warming. */
export interface IdleWarmingOptions {
	/** Whether warming is on; read before every warm. Defaults to the package config. */
	readonly enabled?: () => Promise<boolean>;
	/** Warming has taken over the idle session. */
	readonly onStart?: (ctx: ExtensionContext) => void;
	/** A warm read or wrote the entry for `payload` at `at`. */
	readonly onWarmed?: (payload: unknown, at: number) => void;
	/**
	 * Warming ended with the session still idle, by running out of warms
	 * or for a reason it recorded; the entry was last refreshed at
	 * `refreshedAt`. Nothing real ending it calls this.
	 */
	readonly onEnd?: (ctx: ExtensionContext, refreshedAt: number) => void;
}

/** What warming is doing, for `/compaction-status`. */
export interface IdleWarming {
	describe(): string;
	/**
	 * Take up what a reload of this session carried, after the session's
	 * own `session_start` work, which may cancel what this starts.
	 */
	resume(ctx: ExtensionContext): void;
}

/** Warming, or its end, as a reload carries it to the next extension. */
interface Carried {
	readonly held: HeldRequest;
	readonly refreshedAt: number;
	readonly warms: number;
}

/**
 * What each reloading session carried, by its id. A reload evaluates this
 * module afresh, so it lives on the process, and is taken once.
 */
const carried = (): Map<string, Carried> =>
	processGlobal("agentic-harness.pi/compaction-warm-carried", () => new Map());

/** Keep idle sessions' cache entries warm; see the module comment. */
export function registerIdleWarming(
	pi: ExtensionAPI,
	options: IdleWarmingOptions = {},
): IdleWarming {
	const enabled = options.enabled ?? warmingSwitchedOn;
	let held: HeldRequest | null = null;
	let turnPending = false;
	let turnHeaders: Record<string, string | null> | undefined;
	let run: Run | null = null;
	/** Warming that ended with the session still idle, for a reload to carry. */
	let ended: Carried | null = null;
	/** What a reload carried here, until `resume` takes it up. */
	let inherited: Carried | undefined;
	let last = "waiting for a request";

	/** Leave the run where it is, saying why; nothing real calls `onEnd`. */
	const stop = (reason: string) => {
		ended = null;
		if (!run) return;
		if (run.timer !== undefined) clearTimeout(run.timer);
		run = null;
		last = `stopped: ${reason}`;
	};

	/** Stop, and drop any warm still out, since its runtime is going. */
	const abandon = (reason: string) => {
		run?.controller.abort();
		stop(reason);
		held = null;
	};

	/** End the run while the session is still idle, handing the idle back. */
	const end = (current: Run, reason: string, recorded: boolean) => {
		if (run !== current) return;
		stop(reason);
		ended = {
			held: current.held,
			refreshedAt: current.refreshedAt,
			warms: MAX_IDLE_WARMS,
		};
		if (recorded) {
			record(pi, WARM_STOPPED_ENTRY, { reason, warms: current.warms });
		}
		options.onEnd?.(current.ctx, current.refreshedAt);
	};

	/** What a reload now would carry: the run under way, or its end. */
	const carry = (): Carried | null =>
		run
			? { held: run.held, refreshedAt: run.refreshedAt, warms: run.warms }
			: ended;

	const schedule = (current: Run, dueAt: number, deadline: number) => {
		if (Date.now() > deadline) {
			end(current, "the cache entry is too old to warm", false);
			return;
		}
		current.dueAt = dueAt;
		last = `next warm at ${new Date(dueAt).toISOString()} (${current.warms} of ${MAX_IDLE_WARMS} done)`;
		// A rejection from a timer has nobody above it, and an unhandled one
		// takes pi down; warming is never worth that.
		current.timer = setTimeout(
			() =>
				void warm(current, deadline).catch((error: unknown) => {
					if (run === current) stop(`it broke: ${describe(error)}`);
				}),
			Math.max(0, dueAt - Date.now()),
		);
		current.timer.unref?.();
	};

	const warm = async (current: Run, deadline: number) => {
		current.timer = undefined;
		if (run !== current) return;
		if (!(await enabled())) {
			end(current, `switched off (${CONFIG_SECTION}.${WARM_KEY})`, false);
			return;
		}
		if (run !== current) return;
		if (Date.now() > deadline) {
			end(current, "the timer ran too late to find the entry warm", true);
			return;
		}
		if (!stillIdle(current.ctx)) {
			stop("the session is busy");
			return;
		}
		const sentAt = Date.now();
		const reply = await send(current);
		if (current.controller.signal.aborted) return;
		const failed = !reply.ok;
		if (!failed) {
			current.warms += 1;
			current.refreshedAt = sentAt;
			record(pi, WARM_ENTRY, warmRecord(reply.message, current, sentAt));
			options.onWarmed?.(current.held.payload, sentAt);
		}
		// Something real happened while it was out: its cost is recorded,
		// and nothing more is scheduled.
		if (run !== current) return;
		if (failed) {
			if (!current.retried && Date.now() + RETRY_AFTER_MS <= deadline) {
				current.retried = true;
				schedule(current, Date.now() + RETRY_AFTER_MS, deadline);
				return;
			}
			end(current, `the warm failed: ${reply.reason}`, true);
			return;
		}
		current.retried = false;
		const written = reply.message.usage.cacheWrite;
		if (prefixMissed(reply.message.usage)) {
			end(
				current,
				`the warm wrote ${written} tokens to the cache, more than ${PREFIX_MISS_WRITE_TOKENS}, so its prefix was not there`,
				true,
			);
			return;
		}
		if (current.warms >= MAX_IDLE_WARMS) {
			end(current, `all ${MAX_IDLE_WARMS} warms done`, false);
			return;
		}
		const dueAt = sentAt + current.delayMs;
		schedule(current, dueAt, warmDeadline(dueAt, current.lifetimeMs));
	};

	/**
	 * Warm `from` on: the request held, refreshed at `refreshedAt`, with
	 * `warms` done. A run settling starts from nothing done; a reload
	 * carries on from where the last extension was.
	 */
	const begin = (ctx: ExtensionContext, from: Carried) => {
		const planned = plan(ctx, from.held);
		if (!planned.ok) {
			last = `not warming: ${planned.reason}`;
			return;
		}
		const current: Run = {
			ctx,
			held: planned.held,
			lifetimeMs: planned.lifetimeMs,
			delayMs: planned.delayMs,
			controller: new AbortController(),
			warms: from.warms,
			retried: false,
			refreshedAt: from.refreshedAt,
			dueAt: 0,
		};
		run = current;
		if (current.warms >= MAX_IDLE_WARMS) {
			end(current, `all ${MAX_IDLE_WARMS} warms done`, false);
			return;
		}
		const dueAt = from.refreshedAt + planned.delayMs;
		options.onStart?.(ctx);
		schedule(current, dueAt, warmDeadline(dueAt, planned.lifetimeMs));
	};

	/** Start warming once a run has settled, when there is something to warm. */
	const settle = (ctx: ExtensionContext) => {
		stop("a new run settled");
		if (!held) {
			last = "not warming: nothing sent yet";
			return;
		}
		begin(ctx, { held, refreshedAt: held.at, warms: 0 });
	};

	// The session's own turns, told apart by `context`, which pi fires
	// before each agent-loop call and before nothing else.
	pi.on("context", async () => {
		turnPending = true;
		return undefined;
	});
	pi.on("before_provider_headers", async (event) => {
		if (turnPending) turnHeaders = event.headers;
	});
	pi.on("before_provider_request", async (event, ctx) => {
		if (!turnPending) return;
		turnPending = false;
		const model = ctx.model;
		stop("a new request was sent");
		held = model
			? {
					payload: event.payload,
					// Copied only now: later handlers may still have changed them.
					headers: { ...(turnHeaders ?? {}) },
					model,
					at: Date.now(),
				}
			: null;
		turnHeaders = undefined;
	});
	pi.on("agent_end", async () => {
		turnPending = false;
	});
	pi.on("agent_settled", async (_event, ctx) => {
		settle(ctx);
	});

	// Anything real ends it.
	pi.on("input", async () => stop("a prompt arrived"));
	pi.on("before_agent_start", async () => stop("a run is starting"));
	pi.on("agent_start", async () => stop("a run started"));
	// A compaction under way leaves the session not idle, which stops the
	// next warm; `session_before_compact` stays the host's alone.
	pi.on("session_compact", async () => stop("the session compacted"));
	pi.on("model_select", async () => stop("the model changed"));
	pi.on("thinking_level_select", async () =>
		stop("the thinking level changed"),
	);
	pi.on("session_tree", async () => stop("the session moved in its tree"));
	pi.on("session_start", async (event, ctx) => {
		abandon("the session started");
		const id = sessionIdOf(ctx);
		if (id === undefined) return;
		const kept = carried().get(id);
		carried().delete(id);
		inherited = event.reason === "reload" ? kept : restarted(ctx, id);
	});
	pi.on("session_shutdown", async (event, ctx) => {
		const going = carry();
		abandon("the session shut down");
		const id = sessionIdOf(ctx);
		if (id === undefined) return;
		carried().delete(id);
		if (!going) return;
		if (event.reason === "reload") carried().set(id, going);
		else if (keepingRequests()) keep(onDisk(id, going));
	});

	return {
		describe: () => last,
		resume: (ctx) => {
			const from = inherited;
			inherited = undefined;
			if (!from) return;
			held = from.held;
			begin(ctx, from);
		},
	};
}

type Planned =
	| { ok: true; held: HeldRequest; lifetimeMs: number; delayMs: number }
	| { ok: false; reason: string };

/** Everything that decides, when a run settles, whether to warm. */
function plan(ctx: ExtensionContext, held: HeldRequest | null): Planned {
	if (!IDLE_MODES.has(ctx.mode)) {
		return { ok: false, reason: `${ctx.mode} sessions end with their run` };
	}
	if (!held) return { ok: false, reason: "nothing sent yet" };
	const model = ctx.model;
	if (model?.provider !== held.model.provider || model.id !== held.model.id) {
		return { ok: false, reason: "the model changed since the last request" };
	}
	const replay = replayable(held.payload, held.model.api);
	if (!replay.ok) return replay;
	const lifetimeMs = cacheLifetimeOf(held.payload);
	if (lifetimeMs !== LONG_CACHE_LIFETIME_MS) {
		return {
			ok: false,
			reason: "the request did not ask for an hour's cache",
		};
	}
	const delayMs = warmingDelayMs(lifetimeMs);
	if (delayMs === undefined) {
		return { ok: false, reason: "the cache lifetime is too short" };
	}
	return { ok: true, held, lifetimeMs, delayMs };
}

/**
 * A header whose name says it may carry a credential, never written down;
 * one whose value is shaped like a credential is left out as well.
 */
const CREDENTIAL_HEADER =
	/authorization|api[-_]?key|cookie|token|secret|password/i;

/** What a restart carries, as written to disk: the model by name alone. */
function onDisk(sessionId: string, going: Carried): WarmingCarry {
	const headers = Object.fromEntries(
		Object.entries(going.held.headers).filter(
			([name, value]) =>
				!CREDENTIAL_HEADER.test(name) &&
				scrubSecrets(value ?? "").kinds.length === 0,
		),
	);
	return {
		sessionId,
		payload: going.held.payload,
		headers,
		provider: going.held.model.provider,
		modelId: going.held.model.id,
		at: going.held.at,
		refreshedAt: going.refreshedAt,
		warms: going.warms,
	};
}

/**
 * What the last shutdown of this session kept for warming, taken back
 * once: nothing when none was kept, it is another session's or model's,
 * or the entry it warmed has expired.
 */
function restarted(
	ctx: ExtensionContext,
	sessionId: string,
): Carried | undefined {
	if (!keepingRequests()) return undefined;
	const dir = warmingCarryDir();
	const kept = takeWarmingCarry(dir, sessionId);
	sweepKeptRequests(dir);
	if (!kept) return undefined;
	const { at, refreshedAt, warms, headers } = kept;
	if (Date.now() - refreshedAt > LONG_CACHE_LIFETIME_MS) return undefined;
	const model = ctx.model;
	if (!model || model.provider !== kept.provider || model.id !== kept.modelId) {
		return undefined;
	}
	return {
		held: { payload: kept.payload, headers: { ...headers }, model, at },
		refreshedAt,
		warms,
	};
}

/** Write a restart's carry; a failure costs only a dearer wake, so it is swallowed. */
function keep(carry: WarmingCarry): void {
	try {
		writeWarmingCarry(warmingCarryDir(), carry);
	} catch {
		// Deliberately dropped: shutting down must not fail over a cache
		// the next start can do without.
	}
}

/**
 * Record the warms a pi host sent while this session was parked, as
 * its own warms are recorded, so the spend ledger counts them.
 */
function recordParkedWarms(pi: ExtensionAPI, sessionId: string): void {
	const dir = pendingWarmsDir();
	for (const warm of takePendingWarms(dir, sessionId))
		record(pi, WARM_ENTRY, warm);
	sweepPendingWarms(dir);
}

/** The session's id, or nothing from a context that can no longer say. */
function sessionIdOf(ctx: ExtensionContext): string | undefined {
	try {
		return ctx.sessionManager.getSessionId();
	} catch {
		// A context the session replaced throws on use; it carries nothing.
		return undefined;
	}
}

/** Whether nothing is running or waiting to, on a context still current. */
function stillIdle(ctx: ExtensionContext): boolean {
	try {
		return ctx.isIdle() && !ctx.hasPendingMessages();
	} catch {
		// A context the session replaced throws on use; it is not idle here.
		return false;
	}
}

type Sent =
	| { ok: true; message: AssistantMessage }
	| { ok: false; reason: string };

/** Send the held request again with a one-token cap, through pi's own runtime. */
async function send(current: Run): Promise<Sent> {
	const { ctx, held } = current;
	try {
		const message = await ctx.modelRegistry
			.streamSimple(
				held.model,
				{ messages: [] },
				{
					headers: held.headers,
					sessionId: ctx.sessionManager.getSessionId(),
					maxTokens: 1,
					maxRetries: 0,
					signal: current.controller.signal,
					onPayload: () => warmingPayload(held.payload),
				},
			)
			.result();
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			return { ok: false, reason: message.errorMessage ?? message.stopReason };
		}
		return { ok: true, message };
	} catch (error) {
		return { ok: false, reason: describe(error) };
	}
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** What a warm's entry carries: the side-call shape the spend ledger reads. */
function warmRecord(
	message: AssistantMessage,
	current: Run,
	sentAt: number,
): Record<string, unknown> {
	return {
		provider: message.provider,
		model: message.responseModel ?? message.model,
		usage: message.usage,
		warm: current.warms,
		sinceRequestMs: sentAt - current.held.at,
	};
}

/** Append an entry, unless the runtime it belonged to has gone. */
function record(pi: ExtensionAPI, type: string, data: unknown): void {
	try {
		pi.appendEntry(type, data);
	} catch (error) {
		if (!isStaleContext(error)) throw error;
	}
}

/** The package config's `compaction` section, as far as warming reads it. */
interface CompactionSettings {
	readonly warmWhileIdle: boolean;
}

const parseCompactionSettings: SectionParse<CompactionSettings> = (value) => {
	if (value === undefined) return { ok: true, value: { warmWhileIdle: true } };
	if (!isRecord(value)) {
		return { ok: false, error: `${CONFIG_SECTION} must be an object` };
	}
	const warm = value[WARM_KEY];
	if (warm !== undefined && typeof warm !== "boolean") {
		return {
			ok: false,
			error: `${CONFIG_SECTION}.${WARM_KEY} must be a boolean`,
		};
	}
	return { ok: true, value: { warmWhileIdle: warm ?? true } };
};

/** Whether the package config leaves warming on, as it is by default. */
export async function warmingSwitchedOn(): Promise<boolean> {
	const loaded = await loadPackageConfig();
	if (!loaded.ok) return true;
	return getSection(loaded.config, CONFIG_SECTION, parseCompactionSettings)
		.value.warmWhileIdle;
}

/**
 * Write the compaction summary from the conversation the session
 * already cached, instead of from pi's text dump of it, and write it
 * ahead of the compaction so nobody waits for it.
 *
 * pi's summariser serialises the history under its own system prompt
 * with caching off, so every compaction pays full input price for
 * roughly 150k tokens, truncates every tool result to 2,000
 * characters, and splits a long turn into two calls run one after the
 * other. Here the request the session last sent is kept byte for byte,
 * the messages since are appended, and one closing message asks for
 * the checkpoint. The prefix is a cache read, the model sees every
 * token it summarises, and there is one call.
 *
 * That call still takes a minute or two at real sizes: output runs at
 * about 80 tokens a second and a summary is several thousand. So the
 * trigger asks for it ahead (`prepare`) and work carries on while it
 * is written; when it is ready the compaction applies it at once,
 * keeping verbatim everything that came after the point it covers
 * (`keptBoundary`). A compaction asked for while one is being written
 * waits for that one rather than writing a second.
 *
 * Anything this cannot do cleanly it declines, and pi's own summariser
 * runs as before, so the worst case is pi's behaviour. Each decline is
 * recorded with its reason, so how often it happens is measurable.
 */

import type {
	Api,
	AssistantMessage,
	Model,
	Usage,
} from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import {
	type CompactionResult,
	convertToLlm,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionBeforeCompactEvent,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import {
	extendSentPayload,
	keptBoundary,
	newContributions,
	readSummary,
	SUMMARY_CONTRIBUTIONS,
	SUMMARY_SPAN,
	type SummaryContributions,
	summaryInstruction,
	withFileLists,
} from "../../lib/compaction/index.ts";
import { processGlobal } from "../../lib/internal/process-global.ts";

/** Custom entry recording a compaction this summariser handed back to pi. */
export const SUMMARY_FALLBACK_ENTRY = "compaction-summary-fallback";

/** Custom entry recording a summary written ahead that went unused, and why. */
export const AHEAD_UNUSED_ENTRY = "compaction-summary-ahead-unused";

/** Marks a compaction entry's details as written by this summariser. */
export const SUMMARISER = "conversation";

/** pi's own cap on a summary: this share of the reserve, within the model's limit. */
const SUMMARY_SHARE_OF_RESERVE = 0.8;

/**
 * The reserve a summary written ahead is capped against. pi hands an
 * extension its settings only with a compaction, so ahead of one this
 * is the reserve the failure notice recommends and the harness runs
 * at: a 51,200-token cap.
 */
const ASSUMED_RESERVE_TOKENS = 64_000;

/** How long Anthropic keeps a cache entry under each retention pi asks for. */
const CACHE_LIFETIME_MS = { long: 60 * 60_000, short: 5 * 60_000 } as const;

/** Slack under the lifetime, for the time the request takes to arrive. */
const CACHE_EXPIRY_MARGIN_MS = 30_000;

/** The request a compaction answers with no summary written ahead. */
const ON_THE_SPOT = "on the spot";

/** A summary written ahead of the compaction that applied it. */
const AHEAD = "ahead";

interface SentRequest {
	readonly payload: unknown;
	readonly leafId: string | null;
	readonly modelId: string | undefined;
	readonly at: number;
}

/** A summary's text and what it cost, before it becomes a compaction. */
type Written =
	| { ok: true; text: string; usage: Usage; ms: number }
	| { ok: false; reason: string };

/** A summary being written, or written, ahead of the compaction. */
interface Ahead {
	readonly coveredLeafId: string;
	readonly controller: AbortController;
	readonly done: Promise<Written>;
	result?: Written;
}

/** Where a summary written ahead of the compaction stands. */
export type AheadState = "none" | "writing" | "ready" | "failed";

/** What the trigger can ask of the summariser. */
export interface ConversationSummary {
	/**
	 * Start writing the summary of the conversation as it stands, in the
	 * background. Refused, with the reason, when it cannot be written
	 * from the cache; a summary already under way is left to finish.
	 */
	prepare(ctx: ExtensionContext): { ok: true } | { ok: false; reason: string };
	state(): AheadState;
	/** The reason a summary written ahead failed, once, clearing it. */
	takeFailure(): string | undefined;
	/** Called when a summary written ahead is ready to apply. */
	whenReady(listener: (ctx: ExtensionContext) => void): void;
}

/**
 * Whether the cache the last request wrote may have expired. Reading
 * the conversation back cold would write all of it at the cache-write
 * price, several times what pi's uncached summariser pays, so a manual
 * compaction after a long pause is left to pi.
 */
function cacheMayHaveExpired(sentAt: number, now: number): boolean {
	const lifetime =
		process.env.PI_CACHE_RETENTION === "long"
			? CACHE_LIFETIME_MS.long
			: CACHE_LIFETIME_MS.short;
	return now - sentAt > lifetime - CACHE_EXPIRY_MARGIN_MS;
}

/**
 * The last request, carried across a `/reload`. A reload loads this
 * module afresh, so without it the first compaction after one finds
 * nothing sent and hands back to pi, even though the cache still holds
 * that request. It is taken by the session it came from and no other.
 */
const reloadHandoff = processGlobal<{
	held?: { readonly sessionId: string; readonly sent: SentRequest };
}>("agentic-harness.pi:compaction-summary-handoff", () => ({}));

function enabled(): boolean {
	return process.env.PI_COMPACTION_SUMMARY !== "pi";
}

/**
 * Remember the last request the session sent, write summaries of that
 * same conversation ahead when asked, and answer compaction with one.
 */
export function registerConversationSummary(
	pi: ExtensionAPI,
): ConversationSummary {
	let sent: SentRequest | null = null;
	let ahead: Ahead | null = null;
	const readyListeners: Array<(ctx: ExtensionContext) => void> = [];

	const drop = () => {
		ahead?.controller.abort();
		ahead = null;
	};

	pi.on("session_start", async (event, ctx) => {
		drop();
		const held = reloadHandoff.held;
		reloadHandoff.held = undefined;
		sent =
			event.reason === "reload" &&
			held?.sessionId === ctx.sessionManager.getSessionId()
				? held.sent
				: null;
	});
	pi.on("session_shutdown", async (event, ctx) => {
		drop();
		if (event.reason !== "reload" || !sent) return;
		reloadHandoff.held = { sessionId: ctx.sessionManager.getSessionId(), sent };
	});
	pi.on("session_compact", async () => {
		sent = null;
		drop();
	});

	// Only the session's own requests pass through here; summaries and
	// other direct calls do not, so this is always the conversation.
	pi.on("before_provider_request", async (event, ctx) => {
		sent = {
			payload: event.payload,
			leafId: ctx.sessionManager.getLeafId(),
			modelId: ctx.model?.id,
			at: Date.now(),
		};
	});

	pi.on("session_before_compact", async (event, ctx) => {
		if (!enabled()) return;
		const started = Date.now();
		// Asked for before anything can decline, so a contributor always
		// holds this compaction's request and never a stale one; listeners
		// fill it in synchronously, as pi.events calls them.
		const contributions = newContributions(event.preparation);
		pi.events.emit(SUMMARY_CONTRIBUTIONS, contributions);

		const taken = ahead;
		ahead = null;
		if (taken) {
			const result =
				taken.result ?? (await untilAborted(taken.done, event.signal));
			if (event.signal.aborted) return;
			const used = fromAhead(taken, result, event, ctx, contributions, started);
			if (used.ok) {
				contributions.handled = true;
				return { compaction: used.compaction };
			}
			// A failure while writing was recorded when it happened.
			if (result.ok)
				pi.appendEntry(AHEAD_UNUSED_ENTRY, { reason: used.reason });
		}

		const outcome = await onTheSpot(event, ctx, sent, contributions, started);
		if (outcome.ok) {
			contributions.handled = true;
			return { compaction: outcome.compaction };
		}
		if (event.signal.aborted) return;
		pi.appendEntry(SUMMARY_FALLBACK_ENTRY, { reason: outcome.reason });
		if (ctx.hasUI) {
			ctx.ui.notify(
				`Compacting with pi's summariser: ${outcome.reason}.`,
				"info",
			);
		}
	});

	const state = (): AheadState => {
		if (!ahead) return "none";
		if (!ahead.result) return "writing";
		return ahead.result.ok ? "ready" : "failed";
	};

	return {
		state,
		takeFailure() {
			if (!ahead?.result || ahead.result.ok) return undefined;
			const { reason } = ahead.result;
			ahead = null;
			return reason;
		},
		whenReady(listener) {
			readyListeners.push(listener);
		},
		prepare(ctx) {
			if (!enabled()) {
				return {
					ok: false,
					reason: "PI_COMPACTION_SUMMARY leaves summaries to pi",
				};
			}
			if (ahead && state() !== "failed") return { ok: true };
			const planned = plan(ctx, sent);
			if (!planned.ok) return planned;
			const coveredLeafId = ctx.sessionManager.getLeafId();
			if (coveredLeafId === null) {
				return { ok: false, reason: "the session has nothing to summarise" };
			}

			// Its own request, since there is no compaction yet to key it
			// to: contributors hand in the focus now, and the appendix when
			// the compaction asks again.
			const contributions = newContributions({});
			pi.events.emit(SUMMARY_CONTRIBUTIONS, contributions);
			const instruction = summaryInstruction({
				hasPreviousSummary: ctx.sessionManager
					.getBranch()
					.some((entry) => entry.type === "compaction"),
				customInstructions: focus(undefined, contributions.instructions),
			});
			const controller = new AbortController();
			const entry: Ahead = {
				coveredLeafId,
				controller,
				done: write(ctx, planned, {
					instruction,
					maxTokens: summaryCap(planned.model, ASSUMED_RESERVE_TOKENS),
					signal: controller.signal,
				}).then((result) => {
					if (ahead !== entry || controller.signal.aborted) return result;
					entry.result = result;
					if (!result.ok) {
						pi.appendEntry(AHEAD_UNUSED_ENTRY, { reason: result.reason });
					} else {
						for (const listener of readyListeners) listener(ctx);
					}
					return result;
				}),
			};
			ahead = entry;
			return { ok: true };
		},
	};
}

/**
 * A compaction result carrying the call's usage, which pi records on
 * the compaction entry where the cost ledger reads it. Older pi
 * typings lack the field; the runtime has carried it since 0.85.
 */
interface MeteredCompaction extends CompactionResult {
	readonly usage: Usage;
}

type Summarised =
	| { ok: true; compaction: MeteredCompaction }
	| { ok: false; reason: string };

type Planned =
	| {
			ok: true;
			model: Model<Api>;
			sent: SentRequest;
			tail: ReturnType<typeof sessionEntryToContextMessages>;
	  }
	| { ok: false; reason: string };

/** Everything that decides, before any call, whether the cache can be used. */
function plan(ctx: ExtensionContext, sent: SentRequest | null): Planned {
	const model = ctx.model;
	if (!model) return { ok: false, reason: "no model is selected" };
	if (model.api !== "anthropic-messages") {
		return { ok: false, reason: `the ${model.api} API is not supported` };
	}
	if (!sent) return { ok: false, reason: "nothing has been sent this session" };
	if (sent.modelId !== model.id) {
		return { ok: false, reason: "the model changed since the last request" };
	}
	if (cacheMayHaveExpired(sent.at, Date.now())) {
		return { ok: false, reason: "the cached conversation may have expired" };
	}
	const tail = unsentMessages(ctx, sent.leafId);
	if (!tail.ok) return tail;
	return { ok: true, model, sent, tail: tail.messages };
}

/** Ask the cached conversation for its summary. */
async function write(
	ctx: ExtensionContext,
	planned: Extract<Planned, { ok: true }>,
	options: { instruction: string; maxTokens: number; signal: AbortSignal },
): Promise<Written> {
	const { model, sent } = planned;
	const started = Date.now();
	const messages = convertToLlm([
		...planned.tail,
		{
			role: "user",
			content: [{ type: "text", text: options.instruction }],
			timestamp: Date.now(),
		},
	]);
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) {
		return { ok: false, reason: "no credentials for the model" };
	}

	let splice: string | undefined;
	let reply: AssistantMessage;
	try {
		reply = await completeSimple(
			model,
			{ messages },
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
				signal: options.signal,
				sessionId: ctx.sessionManager.getSessionId(),
				maxTokens: options.maxTokens,
				onPayload: (built: unknown) => {
					const joined = extendSentPayload(
						sent.payload,
						built,
						options.maxTokens,
					);
					if (joined.ok) return joined.payload;
					splice = joined.reason;
					throw new Error(joined.reason);
				},
			},
		);
	} catch (error) {
		return { ok: false, reason: splice ?? describe(error) };
	}
	const read = readSummary(reply);
	if (!read.ok) return { ok: false, reason: splice ?? read.reason };
	return {
		ok: true,
		text: read.text,
		usage: reply.usage,
		ms: Date.now() - started,
	};
}

/** Write the summary now, while the compaction waits for it. */
async function onTheSpot(
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
	sent: SentRequest | null,
	contributions: SummaryContributions,
	started: number,
): Promise<Summarised> {
	// The kept request is the one that overflowed, so sending it again
	// with more on the end can only fail the same way.
	if (event.reason === "overflow") {
		return {
			ok: false,
			reason: "the last request overflowed the context window",
		};
	}
	const planned = plan(ctx, sent);
	if (!planned.ok) return planned;
	const { preparation } = event;
	const written = await write(ctx, planned, {
		instruction: summaryInstruction({
			hasPreviousSummary: preparation.previousSummary !== undefined,
			customInstructions: focus(
				event.customInstructions,
				contributions.instructions,
			),
		}),
		maxTokens: summaryCap(planned.model, preparation.settings.reserveTokens),
		signal: event.signal,
	});
	if (!written.ok) return written;
	return {
		ok: true,
		compaction: checkpoint(written, event, contributions, {
			firstKeptEntryId: preparation.firstKeptEntryId,
			written: ON_THE_SPOT,
			waitedMs: Date.now() - started,
		}),
	};
}

/** Turn a summary written ahead into this compaction, if it still fits. */
function fromAhead(
	taken: Ahead,
	result: Written,
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
	contributions: SummaryContributions,
	started: number,
): Summarised {
	if (!result.ok) return result;
	const branchIds = ctx.sessionManager.getBranch().map((entry) => entry.id);
	const boundary = keptBoundary(
		branchIds,
		taken.coveredLeafId,
		event.preparation.firstKeptEntryId,
	);
	if (!boundary.ok) return boundary;
	return {
		ok: true,
		compaction: checkpoint(result, event, contributions, {
			firstKeptEntryId: boundary.firstKeptEntryId,
			written: AHEAD,
			waitedMs: Date.now() - started,
		}),
	};
}

/**
 * The compaction pi records: the summary opening with the line that
 * says what it covers, the file lists, and whatever contributors
 * appended, with how it was written and how long anybody waited.
 */
function checkpoint(
	written: Extract<Written, { ok: true }>,
	event: SessionBeforeCompactEvent,
	contributions: SummaryContributions,
	how: { firstKeptEntryId: string; written: string; waitedMs: number },
): MeteredCompaction {
	const { summary, readFiles, modifiedFiles } = withFileLists(
		written.text,
		event.preparation.fileOps,
	);
	return {
		summary: `${SUMMARY_SPAN}\n\n${summary}${contributions.appendix.join("")}`,
		firstKeptEntryId: how.firstKeptEntryId,
		tokensBefore: event.preparation.tokensBefore,
		usage: written.usage,
		details: {
			readFiles,
			modifiedFiles,
			summariser: SUMMARISER,
			written: how.written,
			summaryMs: written.ms,
			waitedMs: how.waitedMs,
		},
	};
}

/** The summary being written, or a failure once the compaction is cancelled. */
function untilAborted(
	done: Promise<Written>,
	signal: AbortSignal,
): Promise<Written> {
	if (signal.aborted)
		return Promise.resolve({ ok: false, reason: "cancelled" });
	return new Promise((resolve) => {
		const onAbort = () => resolve({ ok: false, reason: "cancelled" });
		signal.addEventListener("abort", onAbort, { once: true });
		done.then((result) => {
			signal.removeEventListener("abort", onAbort);
			resolve(result);
		});
	});
}

type Tail =
	| { ok: true; messages: ReturnType<typeof sessionEntryToContextMessages> }
	| { ok: false; reason: string };

/**
 * The messages the session holds that the last request did not carry:
 * the reply to it and any tool results since. The first has to be that
 * reply, or the request is not the one this conversation continues.
 */
function unsentMessages(ctx: ExtensionContext, leafId: string | null): Tail {
	const branch = ctx.sessionManager.getBranch();
	const at = leafId === null ? -1 : branch.findIndex((e) => e.id === leafId);
	if (at < 0)
		return { ok: false, reason: "the last request is not on this branch" };
	const messages = branch.slice(at + 1).flatMap(sessionEntryToContextMessages);
	if (messages[0]?.role !== "assistant") {
		return { ok: false, reason: "the session moved on from the last request" };
	}
	return { ok: true, messages };
}

function summaryCap(model: Model<Api>, reserveTokens: number): number {
	return Math.min(
		Math.floor(SUMMARY_SHARE_OF_RESERVE * reserveTokens),
		model.maxTokens,
	);
}

function focus(
	custom: string | undefined,
	contributed: readonly string[],
): string | undefined {
	// A contributor that also asked for this compaction by hand can hand
	// in the same focus both ways; it is said once.
	const parts = new Set(
		[custom, ...contributed].filter((p): p is string => !!p?.trim()),
	);
	return parts.size > 0 ? [...parts].join("\n\n") : undefined;
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

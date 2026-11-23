/**
 * Compaction Workflow extension.
 *
 * Compacts when compacting pays and not before, writes the summary in
 * the background so nobody waits for it, and resumes the run it
 * interrupted.
 *
 * pi compacts when the context is nearly the size of the model's
 * window. On a 1M model that lets a long run read close to a million
 * tokens on every turn. The window stays the ceiling, since some work
 * genuinely needs it, and pi's own trigger still fires there. Below it,
 * each turn adds what the context a compaction would drop cost to read
 * (`droppableRent`), and once that rent since the last compaction has
 * reached what compacting would cost (`compactionPays`), it compacts.
 * That is the cheapest rhythm for a cost that accrues per turn and a
 * fixed cost to clear it; see `lib/compaction/trigger.ts`.
 *
 * The cost is priced from what this session measured, not assumed: the
 * output of its last summary, what the first turn after it rewrote, and
 * what its turns cost beyond their reads. Until the session has
 * compacted once, the defaults below stand in, each from measurement.
 * The summary itself is priced by the provider that would write it,
 * since a summary from the cache and one from pi's uncached summariser
 * differ several times over.
 *
 * Providers: the summary comes from a chain of them (`host.ts`), the
 * `conversation` provider first, which writes from the cached
 * conversation, and `pi` last, which is pi's own summariser. Other
 * extensions add theirs over the bus; see `lib/compaction/provider.ts`.
 *
 * Written ahead: when the trigger fires, the summary is started in the
 * background (`CompactionHost.prepare`) and work carries on. At
 * the first turn's end after it is ready, or at once when the session
 * is idle, the compaction applies it, which takes no time. Only when it
 * cannot be written from the cache does the session compact on the
 * spot, and the notice says why.
 *
 * Idle: an idle session's cache expires after its lifetime, and the
 * first turn back then writes the whole context at the write price.
 * Just before it expires, a session whose context is well past what a
 * compaction keeps is compacted, from the cache while it is still warm
 * (`idleCompactionPays`), so coming back writes only what was kept.
 * One-hour retention only: at five minutes that would compact every
 * pause for coffee.
 *
 * Warming comes first (`warm.ts`): an idle session's last request is
 * sent again with a one-token cap every 54 minutes, up to four times,
 * which keeps its cache entry for nearly five hours at a twentieth of
 * the price of writing it. While warming runs, idle compaction waits;
 * once it ends with the session still idle, idle compaction falls due
 * five minutes before the entry's last refresh expires.
 *
 * Interrupt, trigger, resume: pi's `compact()` aborts the run in
 * progress and does not continue it, so when the turn that tripped the
 * policy made tool calls (the run was going to carry on), a message
 * resumes it once the compaction lands. The resume is a user message,
 * not a custom one: pi starts a run from `sendMessage(..., {
 * triggerTurn: true })` without emitting `before_agent_start`, so that
 * run went out missing everything extensions append to the system
 * prompt, and the next typed message put it back at the cache-write
 * price. A user message goes through pi's prompt path, which emits the
 * hook.
 *
 * A failed compaction resumes the run it interrupted too, is written
 * to the session log (`FAILURE_ENTRY`), and holds the trigger off for
 * a number of turns that doubles with each failure in a row
 * (`turnsBeforeRetry`). A cancelled compaction holds off the same way
 * but is not resumed, since somebody stopped it on purpose.
 *
 * Resumed from the log too: each ask is written (`ASKED_ENTRY`) before
 * the compaction starts, and settled (`SETTLED_ENTRY`) by whichever
 * runtime answers it. The one that asked may be gone by the time its
 * compaction lands: a reload replaced it, or the host or pi stopped.
 * Then the runtime after it reads the ask and resumes the run it owes,
 * once its start is done, or once the compaction lands when that is
 * later. An idle compaction asks with no run going on, so it resumes
 * only a run begun after its ask, which its abort cut.
 *
 * Completed turns only: a turn whose request failed is where pi
 * retries, and compacting there aborts the run it was about to retry.
 * One that was stopped is somebody pressing Escape. Neither triggers a
 * compaction, applies one written ahead, or counts toward the rent;
 * the next turn that completes does.
 *
 * Interactive and RPC sessions only: a subagent runs pi in `--mode
 * json` and ends when its run does, so interrupting one is not
 * something to assume is safe. `PI_COMPACTION_POLICY=off` turns this
 * off, and `PI_COMPACTION_FLOOR_TOKENS` sets a size it never compacts
 * at or below; there is none by default. Past a ceiling set by
 * `PI_COMPACTION_CEILING_TOKENS`, none by default, it compacts whatever
 * rent has been paid, since every turn uploads its whole context.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	FAILURE_ENTRY,
	failureRecord,
	STALLED_ENTRY,
	wasCancelled,
} from "../../lib/compaction/failure.ts";
import { compactionHistory } from "../../lib/compaction/history.ts";
import { emitOutcome } from "../../lib/compaction/outcome.ts";
import {
	ASKED_ENTRY,
	askLanded,
	type CompactionAsk,
	type CompactionSettled,
	cutSince,
	FAILED_RESUME_TEXT,
	FAILED_WAITING_TEXT,
	OWED_WITHIN_MS,
	RESUME_TEXT,
	SETTLED_ENTRY,
	type SettledBy,
	unsettledAsk,
	WAITING_TEXT,
} from "../../lib/compaction/resume.ts";
import {
	type CompactionCost,
	type CompactionPrices,
	compactionCost,
	compactionPays,
	droppableRent,
	idleCompactionPays,
} from "../../lib/compaction/trigger.ts";
import { cachePrices } from "../../lib/internal/cache/cache-prices.ts";
import {
	isStaleContext,
	whileCurrent,
} from "../../lib/internal/errors/stale.ts";
import { contextUsageOf } from "../../lib/internal/session/context-usage.ts";
import { onTurnEnd } from "../../lib/internal/session/turn-end.ts";
import { conversationProvider } from "./conversation.ts";
import { registerFirstHead } from "./head.ts";
import { registerCompactionHost } from "./host.ts";
import { idleTimer } from "./idle.ts";
import {
	compactionFailureNotice,
	compactionNotice,
	idleCompactionNotice,
} from "./notice.ts";
import { piSummaryProvider } from "./pi-summary.ts";
import { registerCompactionStatus } from "./status.ts";
import { registerIdleWarming } from "./warm.ts";

/** Modes whose runs continue after a compaction and can be resumed. */
const RESUMABLE_MODES: ReadonlySet<string> = new Set(["tui", "rpc"]);

/**
 * Tokens a compaction keeps beyond the fixed prompt, before the session
 * has compacted and measured it: pi's default `keepRecentTokens` of
 * 20k, plus room for the summary it writes.
 */
const KEPT_BEYOND_FLOOR = 30_000;

/**
 * How far past that estimate a compaction's keep may run and still say
 * what the next one will keep. One that ran further kept what a late
 * summary never covered: on 9 November two that had waited nine hours
 * kept 510k and 616k, and counting rent only above that, the next
 * compactions waited until 748k and 903k. Healthy ones keep about 100k.
 */
const OUTSIZED_KEEP_TOKENS = 100_000;

/**
 * Output of a summary written from the conversation, thinking included,
 * before the session has one of its own to go by: the median of 36
 * real compactions replayed through it with the summary sized to what
 * it replaces, which wrote 7,148 to 27,067.
 */
const DEFAULT_SUMMARY_OUTPUT_TOKENS = 12_600;

/**
 * Turns spent fetching back what a compaction dropped. Over 97
 * compactions in September, re-fetched tool output cost a median $0.19
 * and a mean $0.35 a compaction under 400k, about three turns at that
 * size, and a comparison cut that dropped nothing found 61 percent as
 * much re-reading. Three is the gross figure, so it errs toward
 * compacting later.
 */
const REFETCH_TURNS = 3;

/**
 * What a turn costs beyond reading its context, before the session has
 * turns of its own to go by: at 100k to 200k tokens under one-hour
 * retention a turn cost $0.076, of which reading was $0.031.
 */
const DEFAULT_TURN_OVERHEAD = 0.045;

/** Weight of each new turn in the running average of turn overhead. */
const OVERHEAD_SMOOTHING = 1 / 50;

/** pi prices models in dollars per million tokens. */
const TOKENS_PER_PRICE_UNIT = 1_000_000;

/** How long before an idle cache expires to compact it. */
const IDLE_LEAD_MS = 5 * 60_000;

/** One-hour cache lifetime, the only retention idle compaction runs under. */
const LONG_CACHE_LIFETIME_MS = 60 * 60_000;

/**
 * Starts the interrupted run again with the same system prompt a typed
 * message gets. Queued behind a run already under way rather than
 * refused, should one have started in the meantime.
 */
function resumeRun(pi: ExtensionAPI, text: string): void {
	pi.sendUserMessage(text, { deliverAs: "followUp" });
}

/**
 * Write that a compaction's ask is answered, before any resume is sent,
 * so a runtime that replaces this one before the resume is logged
 * doesn't send it again.
 */
function settleAsk(pi: ExtensionAPI, resumed: boolean, by: SettledBy): void {
	const settled: CompactionSettled = { at: Date.now(), resumed, by };
	pi.appendEntry(SETTLED_ENTRY, settled);
}

/** How often a check waiting for pi to be idle looks again, in ms. */
const IDLE_LOOKS_EVERY_MS = 250;

/**
 * How long a check waits for pi to be idle, in ms. pi clears its
 * compacting state once every extension's session_compact handler has
 * returned, so one that awaits the disk holds it seconds, not minutes;
 * a run another resumer started is still going after this, and leaves
 * nothing owed by its end.
 */
const IDLE_LOOKS_FOR_MS = 60_000;

/**
 * Run `then` once pi is idle: on the next turn of the loop, and again
 * every IDLE_LOOKS_EVERY_MS until IDLE_LOOKS_FOR_MS has passed, after
 * which it gives up and says so. A context a reload replaced ends it
 * quietly. Any other failure is said rather than thrown, since a throw
 * from a timer has nobody above it to catch and takes pi down.
 */
function whenIdle(
	ctx: ExtensionContext,
	then: () => void,
	until: number = Date.now() + IDLE_LOOKS_FOR_MS,
	looked = false,
): void {
	const look = () => {
		try {
			if (ctx.isIdle()) then();
			else if (Date.now() < until) whenIdle(ctx, then, until, true);
			else
				say(
					`pi stayed busy for ${IDLE_LOOKS_FOR_MS / 1000} s, so the run a compaction owed wasn't started`,
				);
		} catch (error) {
			if (isStaleContext(error)) return;
			const why = error instanceof Error ? error.message : String(error);
			say(`couldn't start the run a compaction owed: ${why}`);
		}
	};
	// The first look waits only for this turn of the loop to finish, as
	// pi's own state settles once the handler that asked returns.
	if (!looked) setImmediate(look);
	// Later looks are spaced, so a long wait costs the loop little.
	else setTimeout(look, IDLE_LOOKS_EVERY_MS);
}

/**
 * Say something on standard error, where a host journals it and an
 * interactive pi's stray-output keeps it off the screen.
 */
function say(line: string): void {
	process.stderr.write(`compaction-workflow: ${line}\n`);
}

/** The starts after which a compaction's owed run is still this session's. */
const OWING_STARTS: ReadonlySet<string> = new Set(["startup", "reload"]);

function enabled(): boolean {
	return process.env.PI_COMPACTION_POLICY !== "off";
}

/** The floor, from the environment when it names a positive number. */
function floorTokens(): number {
	const raw = Number.parseInt(process.env.PI_COMPACTION_FLOOR_TOKENS ?? "", 10);
	return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/**
 * No ceiling unless one is set: a 200k ceiling cut uploads by 11.7
 * percent but cost about $130 a day more.
 */
const DEFAULT_CEILING_TOKENS = 0;

/** The ceiling, from the environment when it names a number; 0 for none. */
function ceilingTokens(): number {
	const raw = Number.parseInt(
		process.env.PI_COMPACTION_CEILING_TOKENS ?? "",
		10,
	);
	if (!Number.isFinite(raw)) return DEFAULT_CEILING_TOKENS;
	return raw > 0 ? raw : 0;
}

/** The active model's prices per token, or nothing without cache pricing. */
function pricesOf(ctx: ExtensionContext): CompactionPrices | undefined {
	const model = ctx.model;
	if (!model) return undefined;
	const cache = cachePrices(
		model.cost,
		model.api,
		process.env.PI_CACHE_RETENTION,
	);
	if (!cache) return undefined;
	return {
		readPrice: cache.readPrice / TOKENS_PER_PRICE_UNIT,
		writePrice: cache.writePrice / TOKENS_PER_PRICE_UNIT,
		outputPrice: model.cost.output / TOKENS_PER_PRICE_UNIT,
	};
}

/** What a turn cost beyond its cache reads, from its usage, if it says. */
function overheadOf(message: unknown): number | null {
	const usage = (
		message as { usage?: { cost?: { total?: unknown; cacheRead?: unknown } } }
	)?.usage;
	const cost = usage?.cost;
	if (typeof cost?.total !== "number") return null;
	return Math.max(
		0,
		cost.total - (typeof cost.cacheRead === "number" ? cost.cacheRead : 0),
	);
}

/**
 * Whether a turn ended without completing, by pi's outcome where it
 * gives one and by the assistant message's stop reason where it does
 * not.
 */
function didNotComplete(event: {
	readonly message: unknown;
	readonly outcome?: string;
}): boolean {
	if (event.outcome === "error" || event.outcome === "aborted") return true;
	const stopReason = (event.message as { stopReason?: unknown })?.stopReason;
	return stopReason === "error" || stopReason === "aborted";
}

function cacheWriteOf(message: unknown): number | null {
	const written = (message as { usage?: { cacheWrite?: unknown } })?.usage
		?.cacheWrite;
	return typeof written === "number" ? written : null;
}

export default function compactionWorkflow(pi: ExtensionAPI) {
	let firstTurnTokens: number | null = null;
	let observedRetained: number | null = null;
	let observedRewrite: number | null = null;
	let summaryOutput: number | null = null;
	let turnOverhead: number | null = null;
	let awaitingRetained = false;
	let rentPaid = 0;
	let compacting = false;
	// The compaction asked of pi and not yet landed or failed, until a
	// run that overtook it has been logged.
	let asked: { at: number; tokens: number } | null = null;
	// Whether this runtime asked for a compaction it hasn't yet answered,
	// so its own landing is left to its onComplete rather than resumed
	// from the log too: pi awaits the work item's end between the two.
	let askOpen = false;
	let failures = 0;
	let holdTurns = 0;

	const conversation = conversationProvider(pi);
	const host = registerCompactionHost(pi, {
		providers: [conversation, piSummaryProvider(pi)],
		expectedOutputTokens: () => summaryOutput ?? DEFAULT_SUMMARY_OUTPUT_TOKENS,
	});
	registerFirstHead(pi);

	// Declared before warming, whose end hands the idle session to it.
	const idle = idleTimer(
		(ctx) => compactIdle(ctx),
		LONG_CACHE_LIFETIME_MS - IDLE_LEAD_MS,
	);

	const warming = registerIdleWarming(pi, {
		onStart: () => idle.cancel(),
		onWarmed: (payload, at) => conversation.refreshed(payload, at),
		onEnd: (ctx, refreshedAt) => {
			if (!enabled() || !RESUMABLE_MODES.has(ctx.mode)) return;
			const wait =
				refreshedAt + LONG_CACHE_LIFETIME_MS - IDLE_LEAD_MS - Date.now();
			if (wait > 0) idle.start(ctx, wait);
		},
	});

	registerCompactionStatus(pi, () => ({
		enabled: enabled(),
		floorTokens: floorTokens(),
		ceilingTokens: ceilingTokens(),
		retention: process.env.PI_CACHE_RETENTION,
		chain: host.chain(),
		ahead: host.state(),
		warming: warming.describe(),
	}));

	const keptEstimate = () => (firstTurnTokens ?? 0) + KEPT_BEYOND_FLOOR;
	const retained = () => observedRetained ?? keptEstimate();
	/** Whether a compaction kept far more than compactions keep. */
	const outsized = (kept: number) =>
		kept - keptEstimate() > OUTSIZED_KEEP_TOKENS;

	/** What compacting a context of this size would cost now. */
	const costAt = (
		ctx: ExtensionContext,
		tokens: number,
		prices: CompactionPrices,
	): CompactionCost =>
		compactionCost({
			summaryDollars: host.summaryDollars(ctx, tokens),
			contextTokens: tokens,
			summaryOutputTokens: summaryOutput ?? DEFAULT_SUMMARY_OUTPUT_TOKENS,
			// Unmeasured, everything kept is assumed rewritten, which errs
			// toward compacting later.
			rewriteTokens: observedRewrite ?? retained(),
			refetchTurns: REFETCH_TURNS,
			refetchTurnCost:
				retained() * prices.readPrice + (turnOverhead ?? DEFAULT_TURN_OVERHEAD),
			prices,
		});

	/** Compact now, resuming the run afterwards when it was going to go on. */
	const compactNow = (
		ctx: ExtensionContext,
		tokens: number,
		resume: boolean,
	) => {
		compacting = true;
		askOpen = true;
		const ask: CompactionAsk = { at: Date.now(), resume };
		asked = { at: ask.at, tokens };
		// A compaction that cannot start (a context the session replaced
		// throws on first use) ends here, or the flag would stay set and
		// keep every later compaction off for the session.
		try {
			// Written first, so a runtime that replaces this one before the
			// compaction lands can tell from the log whether a run is owed.
			pi.appendEntry(ASKED_ENTRY, ask);
			startCompaction(ctx, tokens, ask);
		} catch (error) {
			compacting = false;
			askOpen = false;
			asked = null;
			// An ask that never started is settled, so no later compaction
			// inherits it; a stale pi can't write, and has nothing to settle.
			try {
				settleAsk(pi, false, "asker");
			} catch {
				// The throw below says what went wrong; this one adds nothing.
			}
			throw error;
		}
	};

	const startCompaction = (
		ctx: ExtensionContext,
		tokens: number,
		ask: CompactionAsk,
	) => {
		// A run begun after the ask, which the compaction's abort cut, is
		// owed one too, whatever the turn that asked said.
		const owed = () =>
			ask.resume || cutSince(ctx.sessionManager.getBranch(), ask.at);
		// pi calls these when the compaction ends, which can be after a
		// reload replaced this runtime: on 22 October onError wrote through
		// the stale pi, and the throw, with nothing above it, took pi down.
		// The runtime that replaced it resumes from the log instead (see
		// session_start).
		ctx.compact({
			onComplete: whileCurrent(() => {
				askOpen = false;
				const resume = owed();
				settleAsk(pi, resume, "asker");
				if (resume) resumeRun(pi, RESUME_TEXT);
				else answerWaiting(ctx, WAITING_TEXT);
			}),
			onError: whileCurrent((error: Error) => {
				askOpen = false;
				compacting = false;
				asked = null;
				failures += 1;
				const failure = failureRecord(tokens, error, failures);
				holdTurns = failure.retryAfterTurns;
				pi.appendEntry(FAILURE_ENTRY, failure);
				emitOutcome(pi.events, {
					kind: "failed",
					sessionId: ctx.sessionManager.getSessionId(),
					failure,
				});
				if (ctx.hasUI) {
					ctx.ui.notify(
						compactionFailureNotice(error, failure.retryAfterTurns),
						"warning",
					);
				}
				const cancelled = wasCancelled(error);
				const resume = !cancelled && owed();
				settleAsk(pi, resume, "asker");
				if (resume) resumeRun(pi, FAILED_RESUME_TEXT);
				else if (!cancelled) answerWaiting(ctx, FAILED_WAITING_TEXT);
			}),
		});
	};

	/**
	 * Start a run for messages still waiting once pi is idle. pi's
	 * interactive screen sends what was typed during the compaction itself
	 * as it ends, and any run drains the queue before it ends, so messages
	 * still waiting once pi rests are those only a run of ours delivers.
	 */
	function answerWaiting(ctx: ExtensionContext, text: string): void {
		whenIdle(ctx, () => {
			if (ctx.hasPendingMessages()) resumeRun(pi, text);
		});
	}

	// A summary finished while nobody is working is applied at once: a
	// compaction between runs interrupts nothing.
	host.whenReady((ctx) => {
		if (compacting || !ctx.isIdle()) return;
		compactNow(ctx, contextUsageOf(ctx)?.tokens ?? 0, false);
	});

	function compactIdle(ctx: ExtensionContext) {
		if (!enabled() || compacting || !ctx.isIdle() || ctx.hasPendingMessages())
			return;
		if (process.env.PI_CACHE_RETENTION !== "long") return;
		const tokens = contextUsageOf(ctx)?.tokens ?? null;
		const prices = pricesOf(ctx);
		if (tokens === null || !prices || tokens <= floorTokens()) return;
		const cost = costAt(ctx, tokens, prices);
		const input = {
			contextTokens: tokens,
			retainedTokens: retained(),
			cost,
			prices,
		};
		if (!idleCompactionPays(input)) return;
		if (ctx.hasUI) {
			const avoided = Math.max(0, tokens - retained()) * prices.writePrice;
			ctx.ui.notify(idleCompactionNotice(tokens, avoided, cost), "info");
		}
		compactNow(ctx, tokens, false);
	}

	/**
	 * The context of a start that may owe a run, checked once every
	 * extension's start is done (resources_discover, below).
	 */
	let startOwing: { ctx: ExtensionContext; reason: string } | undefined;

	pi.on("session_start", async (event, ctx) => {
		idle.cancel();
		// A fork, a /resume or a new session is somebody choosing a log, not
		// a runtime coming back to its own: none of them owes a run.
		startOwing = OWING_STARTS.has(event.reason)
			? { ctx, reason: event.reason }
			: undefined;
		// Seeded from the session's own log, not from this process: a resumed
		// session's first turn here is its whole resumed context, which read
		// as the fixed prompt made nothing look droppable.
		const history = compactionHistory(ctx.sessionManager.getBranch());
		firstTurnTokens = history.firstPromptTokens;
		// The log names only the last compaction's keep; an outsized one
		// leaves the estimate to stand in for it.
		const usual =
			history.retainedTokens !== null && !outsized(history.retainedTokens);
		observedRetained = usual ? history.retainedTokens : null;
		observedRewrite = usual ? history.rewriteTokens : null;
		summaryOutput = history.summaryOutputTokens;
		turnOverhead = history.turnOverhead;
		awaitingRetained = false;
		compacting = false;
		askOpen = false;
		asked = null;
		failures = 0;
		holdTurns = 0;
		const prices = pricesOf(ctx);
		rentPaid = prices
			? history.promptsSinceCompaction.reduce(
					(sum, prompt) =>
						sum + droppableRent(prompt, retained(), prices.readPrice),
					0,
				)
			: 0;
		// Last, since it may start the idle timer cancelled above: a reload
		// or a restart carries an idle session's warming on (see warm.ts).
		warming.resume(ctx);
	});

	// Sent once every extension's start has finished, as quest-workflow's
	// first words are: a prompt sent from session_start goes out before
	// later extensions settle their tools, and the tool set declared again
	// after the first turn cost about 21,700 tokens a turn in November.
	pi.on("resources_discover", () => {
		const start = startOwing;
		startOwing = undefined;
		if (start) resumeOwed(start.ctx, start.reason);
	});

	/**
	 * Resume a run the last compaction stopped when the runtime that asked
	 * for it is gone: a reload between the abort and the landing drops
	 * that runtime's resume, and so does a host or pi that stopped. The
	 * ask is settled first, so a reload before the resume is logged can't
	 * send it twice. On a start after pi stopped, an ask whose compaction
	 * neither landed nor failed was cut short with it, and nothing else
	 * will answer it; after a reload its compaction may still land, and
	 * session_compact answers it then.
	 *
	 * Resumed though messages wait to go: pi's compaction aborted the run
	 * they were queued for, which leaves them queued, and only a run
	 * delivers them. With no run owed, a landing that answers an ask, seen
	 * as it lands or from a reload's start (when the asker's onComplete
	 * went with the runtime it replaced), starts one for messages waiting.
	 * A landing nobody here asked for starts nothing: after its own
	 * compaction pi goes on to a turn for queued messages itself
	 * (`_runAutoCompaction` answers `hasQueuedMessages`), so one from here
	 * would be a second.
	 */
	function resumeOwed(ctx: ExtensionContext, reason?: string): void {
		if (!enabled() || !RESUMABLE_MODES.has(ctx.mode)) return;
		whenIdle(ctx, () => {
			const branch = ctx.sessionManager.getBranch();
			const landed = askLanded(branch, Date.now());
			if (landed?.owed) {
				settleAsk(pi, true, "successor");
				resumeRun(pi, RESUME_TEXT);
				return;
			}
			if (landed && ctx.hasPendingMessages()) {
				settleAsk(pi, false, "successor");
				resumeRun(pi, WAITING_TEXT);
				return;
			}
			if (reason !== "startup") return;
			const ask = unsettledAsk(branch, Date.now(), OWED_WITHIN_MS);
			if (ask === undefined) return;
			const resume = ask.resume || cutSince(branch, ask.at);
			settleAsk(pi, resume, "successor");
			if (resume) resumeRun(pi, FAILED_RESUME_TEXT);
		});
	}

	/**
	 * Answer an ask whose compaction failed after the runtime that asked
	 * was gone, as its onError would have: a cancel was somebody stopping
	 * it, so it resumes nothing; otherwise a run it cut is resumed. Read
	 * from the log once pi is idle, so an ask another resumer answered
	 * meanwhile is left alone. With no run to resume, messages left
	 * waiting get a run of their own, unless it was cancelled.
	 */
	function answerFailed(ctx: ExtensionContext, cancelled: boolean): void {
		if (!enabled() || !RESUMABLE_MODES.has(ctx.mode)) return;
		whenIdle(ctx, () => {
			const branch = ctx.sessionManager.getBranch();
			const ask = unsettledAsk(branch, Date.now());
			if (ask === undefined) return;
			const resume = !cancelled && (ask.resume || cutSince(branch, ask.at));
			settleAsk(pi, resume, "successor");
			if (resume) resumeRun(pi, FAILED_RESUME_TEXT);
			else if (!cancelled && ctx.hasPendingMessages()) {
				resumeRun(pi, FAILED_WAITING_TEXT);
			}
		});
	}

	pi.on("session_compact_failed", async (event, ctx) => {
		// One this runtime asked for is its onError's to answer, which pi
		// calls after this event.
		if (!askOpen) answerFailed(ctx, event.aborted);
	});

	pi.on("session_shutdown", async () => {
		idle.cancel();
	});

	pi.on("session_compact", async (event, ctx) => {
		// A compaction another runtime asked for, landing after this one
		// started: a reload while it summarised. Checked once pi is idle
		// again, since it is still compacting while this handler runs. One
		// this runtime asked for is its onComplete's to answer.
		if (!askOpen) resumeOwed(ctx);
		rentPaid = 0;
		compacting = false;
		asked = null;
		awaitingRetained = true;
		failures = 0;
		holdTurns = 0;
		const entry = event.compactionEntry as {
			usage?: { output?: unknown };
			details?: { summariser?: unknown };
		};
		if (
			entry.details?.summariser === "conversation" &&
			typeof entry.usage?.output === "number"
		) {
			summaryOutput = entry.usage.output;
		}
	});

	pi.on("agent_start", async () => {
		idle.cancel();
		// pi refuses a prompt while it compacts, so a run starting while a
		// compaction is asked for means pi has not begun it: a prompt sent
		// as the stopped run settled went first, and the compaction waits
		// for the next idle moment. Said once, so the logs can count it.
		if (compacting && asked) {
			pi.appendEntry(STALLED_ENTRY, {
				contextTokens: asked.tokens,
				askedMsAgo: Date.now() - asked.at,
			});
			asked = null;
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (enabled() && RESUMABLE_MODES.has(ctx.mode)) idle.start(ctx);
	});

	onTurnEnd(pi, async (event, ctx) => {
		if (!enabled() || !RESUMABLE_MODES.has(ctx.mode)) return;
		if (didNotComplete(event)) return;
		// Shared with the status line and the mesh, which ask at the same
		// leaf: each rebuild holds pi's main thread.
		const tokens = contextUsageOf(ctx)?.tokens ?? null;
		if (tokens === null) return;
		if (firstTurnTokens === null) firstTurnTokens = tokens;
		const overhead = overheadOf(event.message);
		if (overhead !== null) {
			turnOverhead =
				turnOverhead === null
					? overhead
					: turnOverhead + OVERHEAD_SMOOTHING * (overhead - turnOverhead);
		}
		if (awaitingRetained) {
			// The first measured prompt after a compaction is what that
			// compaction actually kept, and its cache write what keeping it
			// cost: better estimates than any constant for the next one,
			// unless it kept far more than compactions keep, when the last
			// usual one still says it better.
			if (!outsized(tokens)) {
				observedRetained = tokens;
				observedRewrite = cacheWriteOf(event.message) ?? observedRewrite;
			}
			awaitingRetained = false;
		}
		const prices = pricesOf(ctx);
		if (!prices) return;
		rentPaid += droppableRent(tokens, retained(), prices.readPrice);
		if (compacting) return;
		if (holdTurns > 0) {
			holdTurns -= 1;
			return;
		}

		const resume = event.toolResults.length > 0;
		if (host.state() === "ready") {
			compactNow(ctx, tokens, resume);
			return;
		}

		const decision = compactionPays({
			contextTokens: tokens,
			rentPaid,
			cost: costAt(ctx, tokens, prices),
			floorTokens: floorTokens(),
			ceilingTokens: ceilingTokens(),
			droppableTokens: Math.max(0, tokens - retained()),
		});
		if (!decision.fire) return;

		const failed = host.takeFailure();
		if (host.state() === "writing") return;
		const prepared =
			failed === undefined
				? host.prepare(ctx, tokens)
				: { ok: false as const, reason: failed };
		if (ctx.hasUI) {
			const timing = prepared.ok
				? { ahead: true as const }
				: { ahead: false as const, reason: prepared.reason };
			ctx.ui.notify(compactionNotice(tokens, decision, timing), "info");
		}
		if (!prepared.ok) compactNow(ctx, tokens, resume);
	});
}

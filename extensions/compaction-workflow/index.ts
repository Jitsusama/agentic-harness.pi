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
 *
 * Written ahead: when the trigger fires, the summary is started in the
 * background (`ConversationSummary.prepare`) and work carries on. At
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
 * Interactive and RPC sessions only: a subagent runs pi in `--mode
 * json` and ends when its run does, so interrupting one is not
 * something to assume is safe. `PI_COMPACTION_POLICY=off` turns this
 * off, and `PI_COMPACTION_FLOOR_TOKENS` sets a size it never compacts
 * at or below; there is none by default.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	type CompactionCost,
	type CompactionPrices,
	compactionCost,
	compactionHistory,
	compactionPays,
	droppableRent,
	FAILURE_ENTRY,
	failureRecord,
	idleCompactionPays,
	wasCancelled,
} from "../../lib/compaction/index.ts";
import { cachePrices } from "../../lib/internal/cache-prices.ts";
import { idleTimer } from "./idle.ts";
import {
	compactionFailureNotice,
	compactionNotice,
	idleCompactionNotice,
} from "./notice.ts";
import { registerConversationSummary } from "./summariser.ts";

/** Modes whose runs continue after a compaction and can be resumed. */
const RESUMABLE_MODES: ReadonlySet<string> = new Set(["tui", "rpc"]);

/**
 * Tokens a compaction keeps beyond the fixed prompt, before the session
 * has compacted and measured it: pi's default `keepRecentTokens` of
 * 20k, plus room for the summary it writes.
 */
const KEPT_BEYOND_FLOOR = 30_000;

/**
 * Output of a summary written from the conversation, thinking included,
 * before the session has one of its own to go by: the median of ten
 * real compactions replayed through it (3,739 to 9,668).
 */
const DEFAULT_SUMMARY_OUTPUT_TOKENS = 7_700;

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

const RESUME_TEXT =
	"The context was compacted to keep this session affordable. Carry on " +
	"with the task you were working on from where you left off.";

const FAILED_RESUME_TEXT =
	"Compacting the context failed, so it was left as it is. Carry on " +
	"with the task you were working on from where you left off.";

/**
 * Starts the interrupted run again with the same system prompt a typed
 * message gets. Queued behind a run already under way rather than
 * refused, should one have started in the meantime.
 */
function resumeRun(pi: ExtensionAPI, text: string): void {
	pi.sendUserMessage(text, { deliverAs: "followUp" });
}

function enabled(): boolean {
	return process.env.PI_COMPACTION_POLICY !== "off";
}

/** The floor, from the environment when it names a positive number. */
function floorTokens(): number {
	const raw = Number.parseInt(process.env.PI_COMPACTION_FLOOR_TOKENS ?? "", 10);
	return Number.isFinite(raw) && raw > 0 ? raw : 0;
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

function cacheWriteOf(message: unknown): number | null {
	const written = (message as { usage?: { cacheWrite?: unknown } })?.usage
		?.cacheWrite;
	return typeof written === "number" ? written : null;
}

export default function compactionWorkflow(pi: ExtensionAPI) {
	const summary = registerConversationSummary(pi);

	let firstTurnTokens: number | null = null;
	let observedRetained: number | null = null;
	let observedRewrite: number | null = null;
	let summaryOutput: number | null = null;
	let turnOverhead: number | null = null;
	let awaitingRetained = false;
	let rentPaid = 0;
	let compacting = false;
	let failures = 0;
	let holdTurns = 0;

	const retained = () =>
		observedRetained ?? (firstTurnTokens ?? 0) + KEPT_BEYOND_FLOOR;

	/** What compacting a context of this size would cost now. */
	const costAt = (tokens: number, prices: CompactionPrices): CompactionCost =>
		compactionCost({
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
		ctx.compact({
			onComplete: () => {
				if (!resume || ctx.hasPendingMessages()) return;
				resumeRun(pi, RESUME_TEXT);
			},
			onError: (error) => {
				compacting = false;
				failures += 1;
				const failure = failureRecord(tokens, error, failures);
				holdTurns = failure.retryAfterTurns;
				pi.appendEntry(FAILURE_ENTRY, failure);
				if (ctx.hasUI) {
					ctx.ui.notify(
						compactionFailureNotice(error, failure.retryAfterTurns),
						"warning",
					);
				}
				if (!resume || wasCancelled(error) || ctx.hasPendingMessages()) {
					return;
				}
				resumeRun(pi, FAILED_RESUME_TEXT);
			},
		});
	};

	// A summary finished while nobody is working is applied at once: a
	// compaction between runs interrupts nothing.
	summary.whenReady((ctx) => {
		if (compacting || !ctx.isIdle()) return;
		compactNow(ctx, ctx.getContextUsage()?.tokens ?? 0, false);
	});

	const idle = idleTimer((ctx) => {
		if (!enabled() || compacting || !ctx.isIdle() || ctx.hasPendingMessages())
			return;
		if (process.env.PI_CACHE_RETENTION !== "long") return;
		const tokens = ctx.getContextUsage()?.tokens ?? null;
		const prices = pricesOf(ctx);
		if (tokens === null || !prices || tokens <= floorTokens()) return;
		const cost = costAt(tokens, prices);
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
	}, LONG_CACHE_LIFETIME_MS - IDLE_LEAD_MS);

	// Seeded from the session's own log, not from this process: a resumed
	// session's first turn here is its whole resumed context, which read
	// as the fixed prompt made nothing look droppable.
	pi.on("session_start", async (_event, ctx) => {
		idle.cancel();
		const history = compactionHistory(ctx.sessionManager.getBranch());
		firstTurnTokens = history.firstPromptTokens;
		observedRetained = history.retainedTokens;
		observedRewrite = history.rewriteTokens;
		summaryOutput = history.summaryOutputTokens;
		turnOverhead = history.turnOverhead;
		awaitingRetained = false;
		compacting = false;
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
	});

	pi.on("session_shutdown", async () => {
		idle.cancel();
	});

	pi.on("session_compact", async (event) => {
		rentPaid = 0;
		compacting = false;
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
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (enabled() && RESUMABLE_MODES.has(ctx.mode)) idle.start(ctx);
	});

	pi.on("turn_end", async (event, ctx) => {
		if (!enabled() || !RESUMABLE_MODES.has(ctx.mode)) return;
		const tokens = ctx.getContextUsage()?.tokens ?? null;
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
			// cost: better estimates than any constant for the next one.
			observedRetained = tokens;
			observedRewrite = cacheWriteOf(event.message) ?? observedRewrite;
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
		if (summary.state() === "ready") {
			compactNow(ctx, tokens, resume);
			return;
		}

		const decision = compactionPays({
			contextTokens: tokens,
			rentPaid,
			cost: costAt(tokens, prices),
			floorTokens: floorTokens(),
		});
		if (!decision.fire) return;

		const failed = summary.takeFailure();
		if (summary.state() === "writing") return;
		const prepared =
			failed === undefined
				? summary.prepare(ctx)
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

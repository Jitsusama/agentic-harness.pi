/**
 * Compaction Workflow extension.
 *
 * Compacts when compacting pays, rather than when the window runs out,
 * and resumes the run it interrupted.
 *
 * pi compacts when the context is nearly the size of the model's
 * window. On a 1M model that lets a long run read close to a million
 * tokens on every turn: turns over 200k were 95 percent of the last
 * month's opus spend. The window stays the ceiling, since some work
 * genuinely needs it, and pi's own trigger still fires there. Below it,
 * this asks after every turn whether compacting now pays for itself
 * (`compactionPays`): the reads the droppable context would cost over
 * the turns still to come, against the summariser reading the whole
 * context at full input price and the retained prompt being written
 * fresh. It never fires below 250k tokens.
 *
 * Replayed over a month of real sessions with a simulator validated to
 * five percent of the actual bill, that policy cost 38.7 percent less
 * than compacting at the window. That replay assumes each turn adds the
 * same new content whatever the context size, which a replay cannot
 * prove; the ledger's cost per turn and regret after this is live are
 * the check.
 *
 * Interrupt, trigger, resume: pi's `compact()` aborts the run in
 * progress and does not continue it, so when the turn that tripped the
 * policy made tool calls (the run was going to carry on), a message
 * resumes it once the compaction lands. Nothing is lost that pi's own
 * compaction would not also drop, and pi's compaction keeps a summary
 * and the file list, which is the route back.
 *
 * Recorded exploration: whether one is the right margin to fire at can
 * only be measured if the policy sometimes fires elsewhere, so five
 * percent of stretches (one compaction to the next) draw a threshold of
 * 1/√2 or √2 instead (`drawThreshold`). The draw and its probability go
 * into the session log as a custom entry, which the model never sees,
 * before the decision it shapes, and the notice says when a compaction
 * is one of them. `PI_COMPACTION_EXPLORATION_RATE` sets the share, and
 * zero turns it off.
 *
 * Interactive and RPC sessions only: a subagent runs pi in `--mode
 * json` and ends when its run does, so interrupting one is not
 * something to assume is safe. `PI_COMPACTION_POLICY=off` turns this
 * off, and `PI_COMPACTION_FLOOR_TOKENS` moves the floor.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	compactionHistory,
	compactionPays,
	currentThresholdDraw,
	drawThreshold,
	THRESHOLD_ENTRY,
	type ThresholdDraw,
} from "../../lib/compaction/index.ts";
import { cachePrices } from "../../lib/internal/cache-prices.ts";
import { compactionNotice } from "./notice.ts";

/**
 * Never compact a context smaller than this. At 250k the replay cost
 * the same as no floor at all, with a quarter fewer compactions.
 */
const DEFAULT_FLOOR_TOKENS = 250_000;

/**
 * Share of stretches that draw an explored threshold. Small, since each
 * one spends a little on purpose, and enough over a month of sessions
 * to estimate from.
 */
const DEFAULT_EXPLORATION_RATE = 0.05;

/** Modes whose runs continue after a compaction and can be resumed. */
const RESUMABLE_MODES: ReadonlySet<string> = new Set(["tui", "rpc"]);

/**
 * Tokens a compaction keeps beyond the fixed prompt: pi's default
 * `keepRecentTokens` of 20k, plus room for the summary it writes.
 */
const KEPT_BEYOND_FLOOR = 30_000;

const RESUME_TEXT =
	"The context was compacted to keep this session affordable. Carry on " +
	"with the task you were working on from where you left off.";

function enabled(): boolean {
	return process.env.PI_COMPACTION_POLICY !== "off";
}

/** The floor, from the environment when it names a positive number. */
function floorTokens(): number {
	const raw = Number.parseInt(process.env.PI_COMPACTION_FLOOR_TOKENS ?? "", 10);
	return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_FLOOR_TOKENS;
}

/** The exploration share, from the environment when it names one in [0, 1]. */
function explorationRate(): number {
	const raw = Number.parseFloat(
		process.env.PI_COMPACTION_EXPLORATION_RATE ?? "",
	);
	return Number.isFinite(raw) && raw >= 0 && raw <= 1
		? raw
		: DEFAULT_EXPLORATION_RATE;
}

export default function compactionWorkflow(pi: ExtensionAPI) {
	let turnsSince = 0;
	let firstTurnTokens: number | null = null;
	let observedRetained: number | null = null;
	let awaitingRetained = false;
	let compacting = false;
	let draw: ThresholdDraw | null = null;

	// Seeded from the session's own log, not from this process: a resumed
	// session's first turn here is its whole resumed context, which read
	// as the fixed prompt made nothing look droppable.
	pi.on("session_start", async (_event, ctx) => {
		const history = compactionHistory(ctx.sessionManager.getBranch());
		turnsSince = history.turnsSinceCompaction;
		firstTurnTokens = history.firstPromptTokens;
		observedRetained = history.retainedTokens;
		awaitingRetained = false;
		compacting = false;
		draw = currentThresholdDraw(ctx.sessionManager.getBranch());
	});

	pi.on("session_compact", async () => {
		turnsSince = 0;
		compacting = false;
		awaitingRetained = true;
		draw = null;
	});

	pi.on("turn_end", async (event, ctx) => {
		if (!enabled() || !RESUMABLE_MODES.has(ctx.mode)) return;
		const usage = ctx.getContextUsage();
		const tokens = usage?.tokens ?? null;
		if (tokens === null) return;
		turnsSince += 1;
		if (firstTurnTokens === null) firstTurnTokens = tokens;
		if (awaitingRetained) {
			// The first measured prompt after a compaction is what that
			// compaction actually retained, a better estimate than any
			// constant for the next decision.
			observedRetained = tokens;
			awaitingRetained = false;
		}
		if (compacting) return;

		const model = ctx.model;
		if (!model) return;
		const prices = cachePrices(
			model.cost,
			model.api,
			process.env.PI_CACHE_RETENTION,
		);
		if (!prices) return;

		const floor = floorTokens();
		if (tokens <= floor) return;
		// Drawn on the stretch's first turn that could compact, so only
		// stretches the policy decides for carry a draw, and recorded
		// before the decision it shapes.
		if (draw === null) {
			draw = drawThreshold(Math.random, explorationRate());
			pi.appendEntry(THRESHOLD_ENTRY, draw);
		}

		const retained = observedRetained ?? firstTurnTokens + KEPT_BEYOND_FLOOR;
		const decision = compactionPays({
			contextTokens: tokens,
			retainedTokens: retained,
			turnsSinceCompaction: turnsSince,
			floorTokens: floor,
			threshold: draw.threshold,
			...prices,
		});
		if (!decision.fire) return;

		compacting = true;
		const resume = event.toolResults.length > 0;
		if (ctx.hasUI) {
			ctx.ui.notify(compactionNotice(tokens, decision, draw), "info");
		}
		ctx.compact({
			onComplete: () => {
				if (!resume || ctx.hasPendingMessages()) return;
				pi.sendMessage(
					{
						customType: "compaction-workflow",
						content: RESUME_TEXT,
						display: true,
					},
					{ triggerTurn: true },
				);
			},
			onError: (error) => {
				compacting = false;
				if (ctx.hasUI) {
					ctx.ui.notify(`Compaction failed: ${error.message}`, "warning");
				}
			},
		});
	});
}

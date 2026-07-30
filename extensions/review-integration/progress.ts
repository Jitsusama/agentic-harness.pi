/**
 * A round, on the status line, while it runs.
 *
 * `review_ask` spawns a subprocess per participant and answers only
 * once all of them are done. Without this the useful minutes of a
 * round are minutes in which the surface says nothing, and a roster
 * that is working looks exactly like one that has hung.
 *
 * The shape of what to draw comes from `trackAskProgress` in the
 * library, which folds the events; this file is only the drawing. It
 * deliberately stops at the status line rather than growing a panel:
 * the defect is silence, and one line ends it.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type AskProgress,
	type AskProgressEntry,
	type AskRound,
	trackAskProgress,
} from "../../lib/review/index.js";

/** Ours alone, so clearing it cannot clear somebody else's. */
const STATUS_KEY = "review-ask-progress";

/**
 * The session's context, once pi has handed one over.
 *
 * A tool's execute has no context argument, and a round needs to draw
 * from inside one, so it is held here and set at session start. Null
 * until then, and null in a headless session, which is exactly the
 * case the reporter has to tolerate.
 */
let held: ExtensionContext | null = null;

/** Remember the session's context, for drawing from inside a round. */
export function holdProgressContext(ctx: ExtensionContext | null): void {
	held = ctx;
}

/**
 * Geometry, not emoji, per the review tools' convention: a filled
 * diamond has answered, a half one is working, an open one is waiting
 * and a cross has failed.
 */
const GLYPH: Record<AskProgressEntry["state"], string> = {
	pending: "\u25c7",
	running: "\u25c8",
	answered: "\u25c6",
	failed: "\u2715",
};

/** The one line: who is where, and what the busiest one is doing. */
function line(round: AskRound, entries: readonly AskProgressEntry[]): string {
	const board = entries.map((one) => GLYPH[one.state]).join("");
	const answered = entries.filter((one) => one.state === "answered").length;
	const failed = entries.filter((one) => one.state === "failed").length;
	const parts = [`${round} ${board} ${answered}/${entries.length}`];
	if (failed > 0) parts.push(`${failed} failed`);

	// Name one running participant and what it is doing. One rather
	// than all of them, because six activities do not fit on a line and
	// the question being answered is "is anything happening".
	const busy = entries.find(
		(one) => one.state === "running" && one.activity !== "",
	);
	if (busy) parts.push(`${busy.participantId}: ${busy.activity}`);

	return parts.join("  ");
}

/**
 * A progress observer that draws to the status line and clears itself.
 *
 * Returns the observer to hand to a round. Reporting is best-effort by
 * construction: with no UI attached, every call is a no-op, because a
 * round must not depend on being watched.
 */
export function statusLineProgress(round: AskRound): AskProgress {
	const ctx = held;
	const { progress, entries } = trackAskProgress();
	const draw = (): void => {
		if (!ctx?.hasUI) return;
		const rows = entries();
		if (rows.length === 0) return;
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("muted", line(round, rows)));
	};

	return {
		start(participants) {
			progress.start(participants);
			draw();
		},
		started(id) {
			progress.started(id);
			draw();
		},
		activity(id, what) {
			progress.activity(id, what);
			draw();
		},
		answered(id) {
			progress.answered(id);
			draw();
		},
		failed(id, reason) {
			progress.failed(id, reason);
			draw();
		},
		recorded(id, findings) {
			progress.recorded(id, findings);
			draw();
		},
		finish() {
			progress.finish();
			// Clear rather than leave a finished board up: the round's own
			// answer is about to say all of this properly, and a stale
			// status line outlives the thing it described.
			if (ctx?.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
		},
	};
}

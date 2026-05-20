/**
 * Council progress reporter contract.
 *
 * The council fans reviewers out concurrently. Before
 * this hook, the whole batch ran in silence — the
 * Phase 1 walkthrough recorded 2m 37s of dead air with
 * no signal of which reviewer was still working or
 * whether one had crashed.
 *
 * `CouncilProgress` is a thin observer the orchestrator
 * notifies as each reviewer starts and finishes. The
 * orchestrator stays oblivious to how the observer
 * renders progress; production wires a status-line +
 * widget reporter in `council-progress-render.ts`,
 * tests use an array-backed fake.
 *
 * Every method is best-effort: errors thrown inside
 * progress callbacks are swallowed so a broken reporter
 * can't take down a live council run.
 */

import type { ReviewerOutput } from "./findings.js";
import type { CouncilReviewer } from "./reviewer.js";

/** Per-reviewer lifecycle state surfaced to the UI. */
export type CouncilProgressState =
	| "pending"
	| "running"
	| "complete"
	| "failed";

/** Snapshot of a single reviewer's lifecycle. */
export interface CouncilProgressEntry {
	readonly reviewer: CouncilReviewer;
	readonly state: CouncilProgressState;
	/** Findings parsed from this reviewer; populated after `complete`. */
	readonly findingCount: number;
	/** Warnings reported by the dispatcher and parser. */
	readonly warnings: readonly string[];
	/** Error message when state is `failed`. Empty otherwise. */
	readonly error: string;
}

/** Observer notified as reviewers progress. */
export interface CouncilProgress {
	/**
	 * Called once at the start of a run with the full
	 * roster, all in `pending` state. The reporter can
	 * use this to size the widget.
	 */
	start(entries: readonly CouncilProgressEntry[]): void;

	/** A reviewer has begun dispatch (subprocess spawned). */
	reviewerStarted(reviewerId: string): void;

	/** A reviewer has produced output (parsed successfully). */
	reviewerCompleted(reviewerId: string, output: ReviewerOutput): void;

	/** A reviewer's dispatch threw. */
	reviewerFailed(reviewerId: string, error: string): void;

	/** All reviewers have settled; orchestrator is wrapping up. */
	finish(): void;
}

/**
 * Run a function while reporting to a progress observer.
 * Swallows errors thrown by observer methods so a broken
 * reporter never takes down the run; the orchestrator
 * keeps its own try/catch around the body.
 */
export function safelyNotify(
	fn: () => void,
	tag: string,
	warnings: string[],
): void {
	try {
		fn();
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		warnings.push(`Progress reporter ${tag} failed: ${message}`);
	}
}

/** No-op reporter; used when the caller doesn't supply one. */
export const NULL_PROGRESS: CouncilProgress = {
	start() {},
	reviewerStarted() {},
	reviewerCompleted() {},
	reviewerFailed() {},
	finish() {},
};

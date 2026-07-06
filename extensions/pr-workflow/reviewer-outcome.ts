/**
 * Shared read of a review run's reviewer outcomes.
 *
 * A council, stack review, judge or critique run can finish
 * with every reviewer having failed to verify: they crashed
 * at spawn, or ended without calling verify_output. That
 * used to render as a success banner with the real story
 * buried in a warnings block, so the failure read as
 * success and the caller misdiagnosed it. This helper turns
 * an all-failed run into a loud, named line the summary can
 * lead with, and stays silent the moment one reviewer
 * verified so a partial run is not maligned.
 */

import type { ReviewerVerification } from "../../lib/subagent/subagent.js";

/** The minimal reviewer-outcome shape the banner reads. */
export interface ReviewerOutcomeLike {
	readonly verification?: ReviewerVerification;
	readonly warnings: readonly string[];
}

/**
 * Return a hard-failure banner when every reviewer in the
 * run failed to verify, or null when the roster is empty or
 * at least one reviewer verified. The banner names the
 * count and the likely cause so the caller does not have to
 * dig through warnings to tell a spawn crash from a
 * reviewer that never reported in.
 */
export function reviewerFailureBanner(
	outputs: readonly ReviewerOutcomeLike[],
): string | null {
	if (outputs.length === 0) return null;
	const verified = outputs.filter((o) => o.verification?.ok === true).length;
	if (verified > 0) return null;
	// Every reviewer must carry a genuine failure signal (a
	// verification that was attempted and did not pass), not
	// merely a missing verification, before we call the run
	// failed. This keeps the banner off runs where
	// verification simply was not required.
	const allFailedVerification = outputs.every(
		(o) => o.verification !== undefined && !o.verification.ok,
	);
	if (!allFailedVerification) return null;
	return `⚠ Review FAILED: 0 of ${outputs.length} reviewers produced verified output. ${likelyCause(outputs)}`;
}

/** Name the most probable reason every reviewer failed. */
function likelyCause(outputs: readonly ReviewerOutcomeLike[]): string {
	const crashed = outputs.some((o) =>
		o.warnings.some(
			(w) =>
				w.includes("exited non-zero") ||
				w.includes("child_process") ||
				w.includes("failed to spawn") ||
				w.includes("supervisor exited without"),
		),
	);
	if (crashed) {
		return (
			"The reviewer subprocesses crashed at spawn (often an oversized " +
			"prompt or an unmaterialized worktree). Check the warnings below, " +
			"then re-run."
		);
	}
	const neverCalled = outputs.every((o) => o.verification?.called === false);
	if (neverCalled) {
		return (
			"No reviewer called verify_output, so nothing was captured. " +
			"Re-run, and check the reviewer prompt and tool palette if it repeats."
		);
	}
	return "No reviewer passed verification. Check the warnings below, then re-run.";
}

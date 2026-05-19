/**
 * Stack critic — one model that looks across every PR
 * in a stack and surfaces cross-PR findings.
 *
 * Where the judge consolidates round-1 outputs within a
 * single PR, the stack critic consolidates ACROSS PRs.
 * It reads each PR's judge findings (live for the
 * cursor PR, snapshotted for off-cursor PRs) plus title
 * and body, and emits a flat list of findings that
 * span multiple PRs.
 *
 * Each `StackFinding` carries:
 *   - `homePrNumber`: where the finding should post.
 *     Defaults to the cursor PR if the model can't
 *     pick a better home.
 *   - `spans`: every PR the finding talks about.
 *     Posting attaches all spans by reference in the
 *     finding body so the destination PR's readers
 *     know what else changed.
 *
 * Single reviewer, single subagent invocation. Mirrors
 * the judge module shape, not the council module
 * shape — the value here is wide-view synthesis, not
 * diversity of opinion (the council already provided
 * that per PR).
 */

import type { Finding } from "./findings.js";
import type { CouncilReviewer, ReviewerUsage } from "./reviewer.js";

/**
 * A finding that talks about more than one PR in the
 * stack, or a finding that belongs to a specific PR but
 * was only visible by reading the whole stack.
 *
 * Inherits everything `Finding` carries (id, location,
 * label, subject, discussion, severity, confidence,
 * decorations) and adds the stack-aware fields.
 */
export interface StackFinding extends Finding {
	/** Which PR this finding should post to. */
	readonly homePrNumber: number;
	/** Every PR the finding refers to. Always includes `homePrNumber`. */
	readonly spans: readonly number[];
}

/** Result of one stack-critic round. */
export interface StackCriticRun {
	readonly id: string;
	readonly startedAt: string;
	readonly reviewerId: string;
	readonly findings: StackFinding[];
	readonly warnings: string[];
	/** Token + cost totals when the dispatcher surfaces them. */
	readonly usage?: ReviewerUsage;
}

/**
 * Stack-critic reviewer is configured separately from
 * judge so the user can pick a different model for
 * cross-PR pattern detection.
 */
export type StackCriticReviewer = CouncilReviewer;

/** Cross-PR finding state shared by stack-aware review. */

import type { CritiqueRun } from "./critique.js";
import type { Finding } from "./findings.js";
import type { ReviewerUsage } from "./reviewer.js";

/**
 * A finding that talks about more than one PR in a
 * stack, or a finding that belongs to a specific PR but
 * was only visible by reading the whole stack.
 */
export interface StackFinding extends Finding {
	/** Which PR this finding should post to. */
	readonly homePrNumber: number;
	/** Every PR the finding refers to. Always includes `homePrNumber`. */
	readonly spans: readonly number[];
}

/** Top-level cross-PR finding run. */
export interface StackFindingRun {
	readonly id: string;
	readonly startedAt: string;
	readonly reviewerId: string;
	readonly findings: StackFinding[];
	readonly warnings: string[];
	/** Token + cost totals when the dispatcher surfaces them. */
	readonly usage?: ReviewerUsage;
	/** Most recent critique run covering these cross-PR findings. */
	readonly critique?: CritiqueRun;
}

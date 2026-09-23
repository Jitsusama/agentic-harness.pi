import type { ReclaimAnalysis } from "./reclaim.js";

/**
 * Running totals across a session, so a single call's reading is not
 * the only shape this data comes in. A per-call number answers "is this
 * call unusual"; a running total answers "how much has this session
 * left on the table so far", which is the question worth watching.
 */
export interface ReclaimTotals {
	/** context events observed. */
	readonly calls: number;
	/** Candidates found, summed across every call. */
	readonly candidates: number;
	/** Characters those candidates carried, summed across every call. */
	readonly chars: number;
}

export const INITIAL_TOTALS: ReclaimTotals = {
	calls: 0,
	candidates: 0,
	chars: 0,
};

/** Fold one call's analysis into the running totals. */
export function accumulate(
	totals: ReclaimTotals,
	analysis: ReclaimAnalysis,
): ReclaimTotals {
	return {
		calls: totals.calls + 1,
		candidates: totals.candidates + analysis.candidates.length,
		chars: totals.chars + analysis.totalChars,
	};
}

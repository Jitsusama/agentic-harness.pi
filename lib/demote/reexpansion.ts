/**
 * How much of what was demoted turned out to still be needed. This is
 * the direct measure of pruner error the plan calls for: a controller
 * that never demotes anything anyone asks for again is not being
 * cautious, it is being useless, and a controller whose demotions come
 * straight back is not saving anything, it is paying for the round
 * trip on top of the original cost.
 */
export interface ReexpansionTotals {
	readonly demoted: number;
	readonly reexpanded: number;
}

export const INITIAL_REEXPANSION: ReexpansionTotals = {
	demoted: 0,
	reexpanded: 0,
};

/** Fold `demoted` and/or `reexpanded` counts into the running totals. */
export function accumulateReexpansion(
	totals: ReexpansionTotals,
	delta: { readonly demoted?: number; readonly reexpanded?: number },
): ReexpansionTotals {
	return {
		demoted: totals.demoted + (delta.demoted ?? 0),
		reexpanded: totals.reexpanded + (delta.reexpanded ?? 0),
	};
}

/** Reexpanded over demoted. Zero, not NaN, when nothing has been demoted yet. */
export function reexpansionRate(totals: ReexpansionTotals): number {
	return totals.demoted === 0 ? 0 : totals.reexpanded / totals.demoted;
}

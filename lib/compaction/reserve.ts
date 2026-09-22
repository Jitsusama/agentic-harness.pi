/**
 * Guards `reserveTokens` against making the compaction threshold
 * negative.
 *
 * Compaction fires once resident tokens pass `contextWindow -
 * reserveTokens`. Unclamped, a reserve larger than a model's own window
 * makes that threshold negative, which compacts every single turn: on
 * the real model registry, a reserve of 600,000 does this to 159 of 278
 * models. This is a safeguard to have in place before any future
 * control loop is allowed to adjust the reserve itself; nothing calls
 * it with a live value yet.
 */

/** Absolute floor on the budget left after reserving, in tokens. */
const MIN_BUDGET_FLOOR = 4096;

/** Budget floor as a fraction of the context window, for large windows
 * where the absolute floor alone would be too small a share. */
const MIN_BUDGET_FRACTION = 0.1;

/**
 * Clamp a requested reserve so the remaining budget, `contextWindow -
 * reserve`, is never negative and never smaller than the larger of the
 * absolute floor or a tenth of the window.
 */
export function clampReserveTokens(
	contextWindow: number,
	reserveTokens: number,
): number {
	const floor = Math.max(MIN_BUDGET_FLOOR, contextWindow * MIN_BUDGET_FRACTION);
	const maxReserve = Math.max(0, contextWindow - floor);
	return Math.min(Math.max(0, reserveTokens), maxReserve);
}

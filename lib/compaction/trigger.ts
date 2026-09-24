/**
 * When to compact, decided on cost rather than on the window running
 * out.
 *
 * pi compacts when the context is nearly the size of the model's
 * window, which on a 1M model lets a session read close to a million
 * tokens on every turn before anything is dropped. Keeping the window
 * as the ceiling is right, since some work genuinely needs it; waiting
 * for it on every session is not. This asks, each turn, whether
 * compacting now pays for itself with every cost named:
 *
 * - saved: what the droppable context (everything past the retained
 *   prompt) would cost to read on each of the turns still to come;
 * - cost: pi's summariser reading the whole context at full input
 *   price, plus the retained prompt being written fresh to the cache.
 *
 * The turns still to come are estimated as the turns since the last
 * compaction: absent anything better, a session is as likely to be past
 * its midpoint as before it. That estimate is also what keeps this from
 * compacting early in a session or again straight after a compaction,
 * where there are few turns yet to earn the cost back.
 *
 * Replayed over a month of real sessions with a simulator that
 * reproduces the actual bill within five percent, this policy, never
 * firing below 250k tokens, cost 38.7 percent less than compacting at
 * the window, better than any fixed threshold, with fewer compactions
 * than the best of them.
 */

export interface TriggerInput {
	readonly contextTokens: number;
	/** Estimate of the prompt a compaction would leave behind. */
	readonly retainedTokens: number;
	/** Turns since the session began or last compacted. */
	readonly turnsSinceCompaction: number;
	/** Never compact a context smaller than this. */
	readonly floorTokens: number;
	/** Cache read price per token. */
	readonly readPrice: number;
	/** Full input price per token, which the summariser pays. */
	readonly inputPrice: number;
	/** Cache write price per token under the retention in force. */
	readonly writePrice: number;
	/**
	 * The margin that has to be crossed to fire. One unless this stretch
	 * drew another to explore (see `drawThreshold`).
	 */
	readonly threshold?: number;
}

export interface TriggerDecision {
	readonly fire: boolean;
	/**
	 * Saved over cost. Above one, compacting now pays. It reads just past
	 * the threshold whenever the test fires, since the test fires on the
	 * first turn it crosses, so it decides but does not explain.
	 */
	readonly margin: number;
	/** What compacting now costs, in the prices' units times tokens. */
	readonly cost: number;
	/**
	 * Turns at this size that earn the cost back: cost over what one
	 * turn saves by not reading the dropped context. Infinite when
	 * nothing would be dropped.
	 */
	readonly turnsToRepay: number;
}

/** Whether compacting now pays for itself. */
export function compactionPays(input: TriggerInput): TriggerDecision {
	const droppable = Math.max(0, input.contextTokens - input.retainedTokens);
	const savedPerTurn = droppable * input.readPrice;
	const cost =
		input.contextTokens * input.inputPrice +
		input.retainedTokens * input.writePrice;
	const turnsToRepay =
		savedPerTurn > 0 ? cost / savedPerTurn : Number.POSITIVE_INFINITY;
	if (input.contextTokens <= input.floorTokens) {
		return { fire: false, margin: 0, cost, turnsToRepay };
	}
	const saved = savedPerTurn * input.turnsSinceCompaction;
	const margin = cost > 0 ? saved / cost : 0;
	const threshold = input.threshold ?? 1;
	return { fire: margin > threshold, margin, cost, turnsToRepay };
}

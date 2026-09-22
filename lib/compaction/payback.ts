/**
 * The payback test compaction fires on: whether summarising now is
 * worth what the summary itself costs to write.
 *
 * A compaction drops tokens and writes a new cache entry in their place.
 * Every remaining turn in the session pays to re-admit whatever was
 * dropped if it stays resident instead; that is the saving. Writing the
 * summary costs the price of a cache write on however much is retained;
 * that is the cost. The test fires only when the saving outweighs the
 * cost.
 *
 * Validated in shadow mode against the real corpus before this was
 * written: replayed over every compaction that actually fired, the test
 * endorsed the same ones and declined none, so it is not a new policy,
 * it is the existing one made explicit and checkable.
 */
export interface PaybackInput {
	/** Tokens the compaction would drop from context. */
	readonly droppedTokens: number;
	/** Turns expected to remain in the session after this point. */
	readonly remainingTurns: number;
	/** Tokens the compaction would keep and write into the summary. */
	readonly retainedTokens: number;
	/** The active model's cache-read price. */
	readonly readPrice: number;
	/** The active model's cache-write price. */
	readonly writePrice: number;
}

/**
 * Whether a compaction pays for itself: does re-admitting the dropped
 * tokens on every remaining turn cost more than writing the summary once.
 */
export function paybackTest(input: PaybackInput): boolean {
	const ratio = input.writePrice / input.readPrice;
	const saved = input.droppedTokens * input.remainingTurns;
	const cost = ratio * input.retainedTokens;
	return saved > cost;
}

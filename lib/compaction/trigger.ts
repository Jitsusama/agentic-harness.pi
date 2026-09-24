/**
 * When to compact: once the context a compaction would drop has cost,
 * in reads since the last compaction, as much as compacting costs.
 *
 * Every turn reads the whole context from cache, so context a
 * compaction could drop pays rent on every turn it stays. Compacting
 * stops the rent and has a price of its own. That is the reorder
 * problem from inventory: context accrues at some rate per turn, it
 * costs a read per token per turn to hold, and clearing it costs a
 * fixed amount. Its cheapest rhythm clears once the holding cost paid
 * since the last clear equals the cost of clearing. Before that,
 * compacting throws away context that has not yet cost what dropping
 * it does; after it, every turn pays rent that compacting would have
 * saved. Measured on this harness's own sessions the cost is flat near
 * that point, so what matters is pricing both sides honestly, and it
 * needs no forecast of how long the session will run.
 *
 * What compacting costs, each part measured rather than assumed:
 *
 * - the summary: the summariser reading the context back from cache
 *   and writing the summary, thinking included;
 * - the rewrite: the first turn after writes what the compaction kept
 *   into cache, where it would otherwise have read it;
 * - the re-fetching: turns spent fetching dropped context back. Over 97
 *   compactions in September, re-fetched tool output cost a median $0.19
 *   and a mean $0.35 a compaction under 400k tokens, and a comparison
 *   cut that dropped nothing found 61 percent as much re-reading, so a
 *   few turns' worth is an honest upper bound.
 *
 * Waiting for the summary is not on the list because the summary is
 * written in the background while work goes on; a compaction that has
 * to block is the fallback, not the plan.
 */

/** Prices in dollars per token. */
export interface CompactionPrices {
	readonly readPrice: number;
	readonly writePrice: number;
	readonly outputPrice: number;
}

export interface CompactionCostInput {
	/** Tokens the summariser reads back from cache. */
	readonly contextTokens: number;
	/** Tokens the summary takes to write, thinking included. */
	readonly summaryOutputTokens: number;
	/** Tokens the first turn after the compaction writes to cache. */
	readonly rewriteTokens: number;
	/** Turns expected to go to fetching dropped context back. */
	readonly refetchTurns: number;
	/** What one of those turns costs, in dollars. */
	readonly refetchTurnCost: number;
	readonly prices: CompactionPrices;
}

/** What a compaction costs, in dollars, by part. */
export interface CompactionCost {
	readonly summary: number;
	readonly rewrite: number;
	readonly refetch: number;
	readonly total: number;
}

/** Price a compaction of the context as it stands. */
export function compactionCost(input: CompactionCostInput): CompactionCost {
	const { prices } = input;
	const summary =
		input.contextTokens * prices.readPrice +
		input.summaryOutputTokens * prices.outputPrice;
	// Without the compaction these tokens would have been read, not
	// written, so only the difference is the compaction's.
	const rewrite =
		input.rewriteTokens * Math.max(0, prices.writePrice - prices.readPrice);
	const refetch = input.refetchTurns * input.refetchTurnCost;
	return { summary, rewrite, refetch, total: summary + rewrite + refetch };
}

/**
 * What one turn pays, in dollars, to keep the context a compaction
 * would drop: the read of everything beyond what it keeps.
 */
export function droppableRent(
	contextTokens: number,
	retainedTokens: number,
	readPrice: number,
): number {
	return Math.max(0, contextTokens - retainedTokens) * readPrice;
}

export interface TriggerInput {
	readonly contextTokens: number;
	/** Rent droppable context has paid since the last compaction, in dollars. */
	readonly rentPaid: number;
	readonly cost: CompactionCost;
	/** Never compact a context this small or smaller; zero for no floor. */
	readonly floorTokens: number;
}

export interface TriggerDecision {
	readonly fire: boolean;
	readonly rentPaid: number;
	readonly cost: CompactionCost;
}

/** Whether the rent paid has reached what compacting now would cost. */
export function compactionPays(input: TriggerInput): TriggerDecision {
	const fire =
		input.contextTokens > input.floorTokens &&
		input.rentPaid >= input.cost.total;
	return { fire, rentPaid: input.rentPaid, cost: input.cost };
}

export interface IdleInput {
	readonly contextTokens: number;
	/** Tokens a compaction would keep, which are written back either way. */
	readonly retainedTokens: number;
	readonly cost: CompactionCost;
	readonly prices: CompactionPrices;
}

/**
 * Whether to compact an idle session just before its cache expires.
 *
 * Coming back after the cache has gone, the next turn writes the whole
 * context at the write price. Compacted first, it writes only what the
 * compaction kept, which it would have had to rewrite after any
 * compaction anyway, so the rewrite is not a cost here. What is: the
 * summary, read from the cache while it is still warm, and the turns
 * spent fetching back what was dropped.
 */
export function idleCompactionPays(input: IdleInput): boolean {
	const avoided =
		Math.max(0, input.contextTokens - input.retainedTokens) *
		input.prices.writePrice;
	return avoided >= input.cost.summary + input.cost.refetch;
}

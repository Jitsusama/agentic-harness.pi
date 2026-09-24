/**
 * What the user is told when a compaction fires.
 *
 * Not the margin. The test fires on the first turn the margin crosses
 * one, so at that moment it always reads about 1.0x, which looks like a
 * compaction that buys nothing. It is not: waiting for a larger margin
 * means paying to read the droppable context on every turn in between,
 * and replayed over a month of real sessions, firing at one was cheaper
 * than requiring two, three or five. What the user can weigh is the
 * price and the bet: this much to summarise, repaid if the session runs
 * about this many more turns.
 */

import type {
	ThresholdDraw,
	TriggerDecision,
} from "../../lib/compaction/index.ts";

/** pi prices models in dollars per million tokens. */
const TOKENS_PER_PRICE_UNIT = 1_000_000;

/** Show a context size in thousands of tokens. */
const TOKENS_PER_K = 1_000;

/**
 * The notice for a compaction that is firing. A stretch that drew an
 * explored threshold says so, since it fired earlier or later than the
 * user would otherwise expect, on purpose.
 */
export function compactionNotice(
	tokens: number,
	decision: TriggerDecision,
	draw?: ThresholdDraw,
): string {
	const dollars = (decision.cost / TOKENS_PER_PRICE_UNIT).toFixed(2);
	const notice =
		`Compacting at ${Math.round(tokens / TOKENS_PER_K)}k tokens: ` +
		`$${dollars} to summarise, earned back after about ` +
		`${Math.round(decision.turnsToRepay)} more turns at this size`;
	if (!draw?.explored) return notice;
	return (
		`${notice}. This stretch was drawn to compact once savings reach ` +
		`${draw.threshold.toFixed(2)} times the cost rather than 1, as a ` +
		"logged experiment"
	);
}

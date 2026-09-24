/**
 * What the user is told when a compaction fires, and when one fails.
 *
 * Not the margin. The test fires on the first turn the margin crosses
 * its threshold, so at that moment it always reads about the threshold,
 * which looks like a compaction that buys next to nothing. It is not:
 * waiting for a larger margin means paying to read the droppable
 * context on every turn in between, and replayed over a month of real
 * sessions, firing at one or √2 was cheaper than requiring two, three
 * or five. What the user can weigh is the
 * price and the bet: this much to summarise, repaid if the session runs
 * about this many more turns.
 */

import {
	type ThresholdDraw,
	type TriggerDecision,
	USUAL_THRESHOLD,
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
		`${draw.threshold.toFixed(2)} times the cost rather than ` +
		`${USUAL_THRESHOLD.toFixed(2)}, as a ` +
		"logged experiment"
	);
}

/**
 * pi's words for a summary that ran out of output tokens. Its cap is
 * four fifths of `compaction.reserveTokens`, 13,107 at the default,
 * and a long session's summary plus the model's thinking passes that.
 */
const TOKEN_CAP_MESSAGE = "hit the token cap";

/**
 * A reserve whose summary cap, 51,200 tokens, is 1.9 times the largest
 * summary measured: 27,375 output tokens, thinking included, for a
 * 315k-token session compacted with no cap. A summary rewrites the one
 * before it, so it grows over a long session and needs the headroom.
 * On every model in use (windows of 500k and up) it leaves pi's own
 * window trigger far above where the payback policy compacts.
 */
const SUGGESTED_RESERVE_TOKENS = 64_000;

/**
 * The notice for a compaction that failed: that nothing was lost, why
 * it failed, when it will be tried again, and, for a summary cut off at
 * the token cap, the one setting that fixes it.
 */
export function compactionFailureNotice(
	error: Error,
	retryAfterTurns: number,
): string {
	// pi's messages end in a full stop or not; the notice adds its own.
	const reason = error.message.replace(/\.$/, "");
	const notice =
		`Compaction failed, so the context was left as it is: ${reason}. ` +
		`It will try again in ${retryAfterTurns} turns`;
	if (!error.message.includes(TOKEN_CAP_MESSAGE)) return notice;
	return (
		`${notice}. The summary needs more room than pi reserves for it: ` +
		`set "compaction": { "reserveTokens": ${SUGGESTED_RESERVE_TOKENS} } ` +
		"in ~/.pi/agent/settings.json and run /reload"
	);
}

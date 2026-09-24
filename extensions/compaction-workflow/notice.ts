/**
 * What the user is told when a compaction fires, and when one fails.
 *
 * What it costs, by part, and what the context it drops has already
 * cost in reads: the two sides of the decision, so the user can see
 * why now. And whether the summary is being written in the background
 * or the session has to wait for it, with the reason when it waits,
 * since that is the part the user feels.
 */

import type {
	CompactionCost,
	TriggerDecision,
} from "../../lib/compaction/index.ts";

/** Show a context size in thousands of tokens. */
const TOKENS_PER_K = 1_000;

/** How the summary for a firing compaction is being written. */
export type SummaryTiming = { ahead: true } | { ahead: false; reason: string };

function dollars(amount: number): string {
	return `$${amount.toFixed(2)}`;
}

function size(tokens: number): string {
	return `${Math.round(tokens / TOKENS_PER_K)}k tokens`;
}

function priced(decision: TriggerDecision): string {
	const { cost } = decision;
	return (
		`Compacting costs about ${dollars(cost.total)} ` +
		`(summary ${dollars(cost.summary)}, rewrite ${dollars(cost.rewrite)}, ` +
		`re-fetching ${dollars(cost.refetch)}), and what it drops has cost ` +
		`${dollars(decision.rentPaid)} in reads since the last compaction`
	);
}

/** The notice for a compaction the trigger has decided on. */
export function compactionNotice(
	tokens: number,
	decision: TriggerDecision,
	timing: SummaryTiming,
): string {
	if (timing.ahead) {
		return (
			`Writing a compaction summary in the background at ${size(tokens)}. ` +
			priced(decision)
		);
	}
	return (
		`Compacting at ${size(tokens)} now, since the summary could not be ` +
		`written in the background: ${timing.reason}. ${priced(decision)}`
	);
}

/** The notice for an idle session compacted before its cache expires. */
export function idleCompactionNotice(
	tokens: number,
	avoidedRewrite: number,
	cost: CompactionCost,
): string {
	return (
		`Compacting at ${size(tokens)} while idle, before the cache expires: ` +
		`coming back would rewrite ${dollars(avoidedRewrite)} of context, and ` +
		`compacting now costs about ${dollars(cost.summary + cost.refetch)}`
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

/**
 * Whether a reviewer's outcome counts as having read the change.
 *
 * Two gates ask it: whether another council has earned its cost, and
 * whether a head was read before it is proposed. Each used to count
 * any outcome without a failure, so a round stopped while its
 * reviewers worked, each one recorded as cancelled with nothing
 * raised, read as a council that found nothing. On 25 November that
 * refused 7ZB2F0 a fresh council on #2530717 at c9dc03b5, and the same
 * record would have let that unreviewed head be proposed.
 */

import { isRecord } from "../../../internal/record.ts";
import type { AskLimit } from "./council.ts";

/**
 * The stops that take a reviewer away before it answers, rather than
 * asking it for what it has. These end it with nothing asked.
 */
const TAKEN_AWAY: ReadonlySet<string> = new Set<AskLimit>([
	"cancelled",
	"parent-exit",
	"supervisor-lost",
]);

/**
 * Whether `outcome` was stopped and has nothing to show for it: it
 * raised nothing, and either it was taken away, or a clock stopped it
 * (wall-clock, idle, soft-deadline) and no wrap-up answered. A clock
 * asks the reviewer for what it has, but only an answer to that is a
 * reading; a wrap-up that never ran, or came back empty, read nothing
 * a later round would repeat, whatever it spent.
 */
export function takenAwayEmpty(outcome: unknown): boolean {
	if (!isRecord(outcome)) return false;
	const stopped = outcome.stopped;
	const limit = isRecord(stopped) ? stopped.limit : undefined;
	if (typeof limit !== "string") return false;
	const raised = outcome.findingIds;
	if (Array.isArray(raised) && raised.length > 0) return false;
	return TAKEN_AWAY.has(limit) || outcome.wrappedUp !== true;
}

/**
 * Whether `outcome` is a reviewer's answer: no failure, and not taken
 * away before it raised anything.
 */
export function answeredOutcome(outcome: unknown): boolean {
	if (!isRecord(outcome)) return false;
	if (outcome.failure !== undefined) return false;
	return !takenAwayEmpty(outcome);
}

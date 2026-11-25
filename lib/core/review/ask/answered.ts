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
 * asking it for what it has. A clock running out (wall-clock, idle,
 * soft-deadline) asks the reviewer to answer, so what it returns is
 * its reading; these end it with nothing asked.
 */
const TAKEN_AWAY: ReadonlySet<string> = new Set<AskLimit>([
	"cancelled",
	"parent-exit",
	"supervisor-lost",
]);

/**
 * Whether `outcome` was taken away before it answered and raised
 * nothing: it read nothing a later round would repeat, whatever it
 * spent.
 */
export function takenAwayEmpty(outcome: unknown): boolean {
	if (!isRecord(outcome)) return false;
	const stopped = outcome.stopped;
	const limit = isRecord(stopped) ? stopped.limit : undefined;
	if (typeof limit !== "string" || !TAKEN_AWAY.has(limit)) return false;
	const raised = outcome.findingIds;
	return !(Array.isArray(raised) && raised.length > 0);
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

/**
 * Types for the governance rule store.
 *
 * A governance rule is a behavioural lesson captured from a past
 * correction: a short imperative the agent should follow going
 * forward. Rules are the durable output of correction capture and
 * the watch-list the advisor reviews turns against.
 */

/** A single captured behavioural rule. */
export interface GovernanceRule {
	/** Stable short identifier, unique within the store. */
	readonly id: string;
	/** The rule itself, phrased as an imperative. */
	readonly text: string;
	/** ISO timestamp of when the rule was filed. */
	readonly createdAt: string;
	/** Where the rule came from, e.g. a capturing session id. */
	readonly source?: string;
}

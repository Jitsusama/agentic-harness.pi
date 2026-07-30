/**
 * Publishing one review across a stack.
 *
 * A draft is about one change, so a review of a stack is several
 * drafts published together. The fan-out exists because publishing
 * them one at a time by hand loses the only thing a caller needs
 * afterwards: which changes now carry the review and which do not.
 *
 * The rule inside one plan applies again here, one level up. A change
 * that failed does not stop the changes after it, because stopping
 * leaves a partly published review with no record of which part
 * landed, and the caller's only recourse is to post everything twice
 * or abandon the lot. So every change reports its own outcome,
 * execution continues past a failure, and the answer says plainly what
 * is left.
 *
 * Publishing is sequential rather than concurrent. Six reviews landing
 * at once on a stack is six notifications in an unpredictable order to
 * whoever is watching it, and a rate limit hit halfway through
 * concurrent posts leaves a mess that is harder to describe than a
 * slow success.
 */

import type { ChangeRef } from "../change.js";
import type { ReviewProvider } from "../provider.js";
import type { PublishPlan } from "./plan.js";
import { type PublishOutcome, publishPlan } from "./publish.js";

/** One change in the stack, and what to publish to it. */
export interface StackPublishEntry {
	/** The change's ref, which is how a reader names it. */
	ref: string;
	change: ChangeRef;
	plan: PublishPlan;
}

/** What became of one change. */
export interface ChangePublishOutcome {
	ref: string;
	change: ChangeRef;
	outcome: PublishOutcome;
}

/** What became of the whole fan-out. */
export interface StackPublishOutcome {
	/** True only when every change landed everything. */
	ok: boolean;
	/** In the order the entries were given. */
	changes: ChangePublishOutcome[];
	/** Refs that carry their whole review now. */
	landed: string[];
	/** Refs a retry should send again. */
	remaining: string[];
}

/**
 * Publish a review to every change in a stack.
 *
 * Entries are published in the order given, which a caller should make
 * stack order so a reader meets the remarks the way the stack applies.
 */
export async function publishAcross(
	entries: readonly StackPublishEntry[],
	provider: ReviewProvider,
): Promise<StackPublishOutcome> {
	const changes: ChangePublishOutcome[] = [];
	const landed: string[] = [];
	const remaining: string[] = [];

	for (const entry of entries) {
		const outcome = await publishPlan(entry.plan, provider);
		changes.push({ ref: entry.ref, change: entry.change, outcome });
		// A plan with no operations lands trivially. Calling it remaining
		// would keep a retry alive forever over a change nobody had a
		// remark about.
		if (outcome.ok) landed.push(entry.ref);
		else remaining.push(entry.ref);
	}

	return { ok: remaining.length === 0, changes, landed, remaining };
}

/**
 * Where GitHub says a pull request stands with a merge queue.
 *
 * The queue is not on the REST representation and not among the fields
 * `gh pr view --json` offers, so this is the one place the GitHub
 * provider has to ask GraphQL. Both facts were checked against a live
 * API rather than assumed: `gh pr view --json` lists `autoMergeRequest`
 * and `mergeStateStatus` and nothing else queue-shaped, and
 * `MergeQueueEntry` exists only on the GraphQL `PullRequest`.
 *
 * GitHub's own vocabulary turned out to be sharper than the neutral
 * model's first draft. `MergeQueueEntryState` distinguishes
 * `AWAITING_CHECKS` from `QUEUED`, and `MergeQueueEntry.solo` says
 * whether the change is being tested by itself or batched with others.
 * That last one is the difference between ejecting one change's checks
 * and ejecting a batch's, which is the whole reason a caller asks.
 */

import type { Landability } from "../../landing.js";
import type { QueueState } from "../../queue.js";

/** The GraphQL selection this module reads. */
export const QUEUE_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      isInMergeQueue
      autoMergeRequest{enabledAt}
      mergeQueueEntry{state position solo}
      reviewDecision
      mergeStateStatus
      mergeable
    }
  }
}`;

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: {};
}

/**
 * Where GitHub says the change stands with landing.
 *
 * Read from the query the queue already runs, so it costs nothing extra. Three fields
 * rather than one, because GitHub splits the question the same way this model does:
 * `reviewDecision` is the people, `mergeStateStatus` is the checks and the base, and
 * `mergeable` is whether the trees still agree.
 *
 * `BLOCKED` deliberately does not become `failingRequiredCheck`. It means a required
 * status has not passed, which covers one that has not run as well as one that failed, and
 * naming a check as failing when it merely has not started sends somebody to read a log
 * that does not exist. The word itself is passed through instead.
 */
export function landabilityFrom(raw: unknown): Landability | undefined {
	const pull = record(record(record(record(raw).data).repository).pullRequest);
	const decision =
		typeof pull.reviewDecision === "string" ? pull.reviewDecision : undefined;
	const status =
		typeof pull.mergeStateStatus === "string"
			? pull.mergeStateStatus
			: undefined;
	const mergeable =
		typeof pull.mergeable === "string" ? pull.mergeable : undefined;

	if (
		decision === undefined &&
		status === undefined &&
		mergeable === undefined
	) {
		return undefined;
	}

	return {
		...(status === undefined ? {} : { reason: status.toLowerCase() }),
		...(decision === undefined
			? {}
			: {
					approved: decision === "APPROVED",
					changesRequested: decision === "CHANGES_REQUESTED",
				}),
		...(mergeable === undefined
			? {}
			: { conflicted: mergeable === "CONFLICTING" }),
	};
}

/**
 * Whether an entry's state means the queue is still waiting on checks.
 *
 * `AWAITING_CHECKS` is GitHub testing the batch and not yet ready to
 * land it. The others (`QUEUED`, `MERGEABLE`, `LOCKED`, `UNMERGEABLE`)
 * all mean the entry is holding a place, which is the expensive posture.
 */
function awaitingChecks(state: string | undefined): boolean {
	return state === "AWAITING_CHECKS";
}

/**
 * Translate GitHub's answer into the neutral queue state.
 *
 * Three sources, in order of how much they cost to be wrong about.
 * A merge queue entry is authoritative and detailed. Failing that, an
 * auto-merge request means somebody has asked for this to land and the
 * backend is waiting, which is the `waiting` posture rather than the
 * `queued` one: nothing is batched, so nothing else gets ejected.
 * Failing both, the change is not queued.
 */
export function queueStateFrom(raw: unknown): QueueState {
	// The `data` envelope is part of the answer, not something a caller
	// should have to strip: `gh api graphql` returns it unless it is given
	// a `--jq`, and a reader that quietly accepted either shape would read
	// an unwrapped answer as unqueued rather than saying so.
	const pull = record(record(record(record(raw).data).repository).pullRequest);
	const entry = pull.mergeQueueEntry;

	if (entry !== null && entry !== undefined) {
		const held = record(entry);
		const state = typeof held.state === "string" ? held.state : undefined;
		return {
			posture: awaitingChecks(state) ? "waiting" : "queued",
			...(typeof held.solo === "boolean" ? { solo: held.solo } : {}),
			...(typeof held.position === "number" ? { position: held.position } : {}),
			...(state ? { detail: `merge queue entry is ${state}` } : {}),
		};
	}

	// A queue entry is the only thing that batches, so auto-merge on its
	// own is the cheaper hazard: the checks already ran and will not run
	// again, but nobody else's work is riding on this one.
	if (record(pull.autoMergeRequest).enabledAt !== undefined) {
		return {
			posture: "waiting",
			solo: true,
			detail: "auto-merge is enabled and the backend is waiting on checks",
		};
	}

	return { posture: "unqueued" };
}

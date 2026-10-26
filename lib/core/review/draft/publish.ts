/**
 * Running a plan, honestly.
 *
 * Publishing a review is several requests, and the interesting
 * case is the one where some of them work. A posted review
 * with one failed reply is not a failure to report as "could
 * not publish", because the review is now on the change and
 * saying otherwise would have someone post it twice. So every
 * operation reports its own outcome, execution continues past
 * a failure, and the caller learns exactly which items landed.
 */

import type { ChangeRef } from "../change.ts";
import type { Posted } from "../conversation.ts";
import type { ReviewProvider } from "../provider.ts";
import type { PlannedOp, PublishPlan } from "./plan.ts";

/** What became of one planned operation. */
export interface OpOutcome {
	op: PlannedOp;
	ok: boolean;
	/** Items the operation carried, whether it landed or not. */
	itemIds: string[];
	posted?: Posted;
	error?: string;
}

/** What became of the whole plan. */
export interface PublishOutcome {
	/** True only when every operation landed. */
	ok: boolean;
	outcomes: OpOutcome[];
}

/** How a caller may watch and stop a publish. */
export interface PublishOptions {
	/**
	 * Stops the publish between operations. The one in flight is left to
	 * finish, since a request already sent may land whatever happens
	 * here, and every operation after it is reported as not sent.
	 */
	signal?: AbortSignal;
	/**
	 * Told about each operation as soon as it has run, before the next
	 * one starts. This is where a caller records what landed, so a
	 * session that dies partway leaves a record a retry can trust.
	 */
	onOutcome?: (outcome: OpOutcome) => Promise<void>;
}

/** What an operation left unsent by a stop says about itself. */
export const STOPPED_BEFORE_SENT = "stopped before this was sent";

/** The message an unusable error becomes. */
function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Every operation failed for the same reason. */
function allFailed(plan: PublishPlan, error: string): PublishOutcome {
	return {
		ok: false,
		outcomes: plan.ops.map((op) => ({
			op,
			ok: false,
			itemIds: op.itemIds,
			error,
		})),
	};
}

/**
 * Perform one operation. Returns what the provider handed
 * back, or throws for the caller to record.
 */
async function perform(
	op: PlannedOp,
	provider: ReviewProvider,
	change: ChangeRef,
): Promise<Posted | undefined> {
	const conversation = provider.conversation;
	if (!conversation) {
		throw new Error(`the ${provider.id} provider has no conversation facet`);
	}

	if (op.kind === "review") {
		return conversation.postReview(change, {
			verdict: op.verdict,
			body: op.body,
			comments: op.comments,
		});
	}
	if (op.kind === "comment") {
		return conversation.comment(change, op.body);
	}
	if (op.kind === "commentOn") {
		if (!conversation.commentOn) {
			// The planner only makes one of these for a provider declaring
			// `fileLevelComments: "standalone"`, which is a promise of this
			// method, so reaching here means the declaration was wrong. Said
			// plainly rather than swallowed: the remark is in the draft still,
			// and publishing again after the provider is fixed will send it.
			throw new Error(
				`the ${provider.id} provider says a remark about a whole file has to be posted on its own, and then offers no way to post one`,
			);
		}
		return conversation.commentOn(change, op.comment.anchor, op.comment.body);
	}
	if (op.kind === "reply") {
		return conversation.reply(change, op.thread, op.body);
	}
	if (op.kind === "resolve") {
		await conversation.resolve(change, op.thread);
		return undefined;
	}
	if (op.kind === "unresolve") {
		if (!conversation.unresolve) {
			throw new Error(
				`the ${provider.id} provider cannot reopen a resolved thread`,
			);
		}
		await conversation.unresolve(change, op.thread);
		return undefined;
	}
	if (!conversation.react) {
		throw new Error(`the ${provider.id} provider cannot post reactions`);
	}
	await conversation.react(change, op.subject, op.reaction);
	return undefined;
}

/** Perform one operation and say what became of it. */
async function attempt(
	op: PlannedOp,
	provider: ReviewProvider,
	change: ChangeRef,
): Promise<OpOutcome> {
	try {
		const posted = await perform(op, provider, change);
		return { op, ok: true, itemIds: op.itemIds, ...(posted ? { posted } : {}) };
	} catch (error) {
		return { op, ok: false, itemIds: op.itemIds, error: messageOf(error) };
	}
}

/**
 * Run a compiled plan against a provider.
 *
 * Operations run in the order the plan puts them and a
 * failure does not stop the ones after it, because the
 * alternative is a review posted with half its replies
 * missing and no record of which half.
 */
export async function publishPlan(
	plan: PublishPlan,
	provider: ReviewProvider,
	options: PublishOptions = {},
): Promise<PublishOutcome> {
	if (plan.ops.length === 0) return { ok: true, outcomes: [] };

	if (plan.target.kind !== "change") {
		return allFailed(
			plan,
			"this target is not hosted anywhere, so there is no change " +
				"to publish to; render the review as a document instead",
		);
	}
	if (!provider.conversation) {
		return allFailed(
			plan,
			`the ${provider.id} provider has no conversation facet`,
		);
	}

	const change = plan.target.change;
	const outcomes: OpOutcome[] = [];
	for (const op of plan.ops) {
		const outcome = options.signal?.aborted
			? {
					op,
					ok: false,
					itemIds: op.itemIds,
					error: STOPPED_BEFORE_SENT,
				}
			: await attempt(op, provider, change);
		outcomes.push(outcome);
		await options.onOutcome?.(outcome);
	}

	return { ok: outcomes.every((entry) => entry.ok), outcomes };
}

/**
 * Whether an authoring intent will work here, asked before trying.
 *
 * Reviewing degrades gracefully: a comment that cannot anchor becomes
 * prose and the reader still gets the remark. Authoring does not. A
 * retarget that means something different on this backend moves changes
 * nobody asked to move, and a push to a change sitting in a merge queue
 * ejects it and everything batched with it. The cheap moment to find
 * out is before the call, not from a rejected request.
 *
 * So this answers three things rather than one: whether it will work,
 * why not, and what to do instead. The third is what makes a refusal
 * useful. A caller told only that something is unsupported has to go
 * and read a CLI's help to find the door that is open, and every
 * difference encoded here was found by doing exactly that.
 */

import type { AuthoringCapabilities } from "./capabilities.js";
import { type QueueState, queueRefusal } from "./queue.js";

/** Something a caller wants to do to a proposal. */
export interface AuthoringIntent {
	kind:
		| "propose"
		| "propose-stack"
		/**
		 * Changing a change's own text: title, body, labels, assignees.
		 *
		 * Kept apart from `retarget` because only moving the base is a
		 * retarget, and conflating them refused a title change on a
		 * backend where retargeting happens to be a stack operation.
		 */
		| "edit"
		| "retarget"
		| "set-draft"
		| "close"
		| "reopen"
		| "merge"
		| "request-reviewers"
		/**
		 * Asking CI to run again.
		 *
		 * Not in {@link MUTATES}: a rerun starts a build, it does not
		 * move the branch or the base, so it does not eject a change
		 * from a merge queue the way an edit or a retarget does.
		 */
		| "rerun-checks";
	/** Naming reviewers as part of proposing. */
	withReviewers?: boolean;
	/**
	 * Where the change stands with a merge queue, read from the
	 * proposal rather than decided by the caller.
	 *
	 * This was a boolean, and a boolean was wrong twice over. Nothing
	 * ever set it, so the refusal below could not be reached; and it
	 * could not tell a change batched with fifty others from one being
	 * tested alone, which is the whole difference between an expensive
	 * mistake and a cheap one.
	 */
	queue?: QueueState;
}

/**
 * Whether it will work, and what to do instead when it will not.
 *
 * The permitted arm carries an optional `caution`, for the case that is
 * neither safe nor refusable: a backend that has a merge queue and could
 * not tell us where this change stands in it. Refusing would make every
 * unreachable queue a read-only backend, and permitting silently hands
 * somebody an expensive mistake with no warning. So it is permitted, out
 * loud, and the confirmation gate is where a person decides.
 */
export type Offerable =
	| { ok: true; caution?: string }
	| { ok: false; reason: string; instead?: string };

/**
 * Intents that change the change itself.
 *
 * Merging is deliberately absent: a queue exists to merge things, so
 * merging is not a mutation the queue objects to. Closing is absent for
 * the same reason a queue does not care, and because a caller closing
 * an enqueued change has already decided.
 */
const MUTATES: ReadonlySet<AuthoringIntent["kind"]> = new Set([
	"edit",
	"retarget",
	"set-draft",
]);

/** Whether this provider will accept this intent, and what to say. */
export function offerable(
	intent: AuthoringIntent,
	capabilities: AuthoringCapabilities | undefined,
	providerId: string,
): Offerable {
	if (capabilities === undefined) {
		return {
			ok: false,
			reason: `The ${providerId} provider does not author changes, so there is nothing here to ${intent.kind.replace("-", " ")}.`,
		};
	}

	// Asked before the per-intent questions, because a queue ejection is
	// expensive whatever the intent was and the answer does not depend
	// on whether the backend could otherwise do it.
	const queued = capabilities.refusesWhileEnqueued && MUTATES.has(intent.kind);
	if (queued) {
		const refusal = queueRefusal(intent.queue, providerId);
		if (refusal) return { ok: false, ...refusal };
	}

	// Having a queue and not knowing where the change sits in it is its own
	// answer: on some backends the queue lives somewhere the change's own
	// API cannot see, so silence there is ignorance rather than safety.
	//
	// It decorates the answer instead of being one. Returning it directly
	// skipped every per-intent question below, which permitted a retarget
	// on a backend that had just said it could not do one. Three tests
	// caught that, which is the only reason this reads as it does.
	const answer = decide(intent, capabilities, providerId);
	if (!answer.ok || !queued || intent.queue !== undefined) return answer;
	return {
		...answer,
		caution: `${providerId} has a merge queue and did not say where this change stands in it. If it is queued, this ejects it and everything batched with it. Check before approving.`,
	};
}

/** What this provider says about this intent, queue aside. */
function decide(
	intent: AuthoringIntent,
	capabilities: AuthoringCapabilities,
	providerId: string,
): Offerable {
	switch (intent.kind) {
		case "propose":
			return proposable(intent, capabilities, providerId);
		case "edit":
			// Every backend surveyed can change a change's own text. The
			// queue check above is the only thing that stops an edit, which
			// is the whole reason this is not folded into `retarget`.
			return { ok: true };
		case "propose-stack":
			return capabilities.proposeStack
				? { ok: true }
				: {
						ok: false,
						reason: `The ${providerId} provider proposes one change at a time.`,
						instead:
							"Propose each change in the stack in dependency order, roots first.",
					};
		case "retarget":
			return retargetable(capabilities, providerId);
		case "set-draft":
			return capabilities.setDraft
				? { ok: true }
				: {
						ok: false,
						reason: `The ${providerId} provider cannot move an existing change between draft and ready.`,
						instead:
							"Decide draft or ready when the change is proposed, since this backend fixes it then.",
					};
		case "reopen":
			return capabilities.reopen
				? { ok: true }
				: {
						ok: false,
						reason: `The ${providerId} provider cannot reopen a closed change.`,
						instead: "Propose the work again as a new change.",
					};
		case "close":
			return capabilities.close
				? { ok: true }
				: {
						ok: false,
						reason: `The ${providerId} provider cannot close a change.`,
					};
		case "merge":
			return capabilities.merge
				? { ok: true }
				: {
						ok: false,
						reason: `The ${providerId} provider cannot merge a change.`,
					};
		case "request-reviewers":
			return reviewable(capabilities, providerId);
		case "rerun-checks":
			return capabilities.rerunChecks
				? { ok: true }
				: {
						ok: false,
						reason: `The ${providerId} provider cannot ask CI to run again.`,
						instead:
							"Retrigger it wherever that backend's CI is driven from, which is not always the same system that hosts the change.",
					};
	}
}

/** Proposing, and whether reviewers can ride along. */
function proposable(
	intent: AuthoringIntent,
	capabilities: AuthoringCapabilities,
	providerId: string,
): Offerable {
	if (!capabilities.propose) {
		return {
			ok: false,
			reason: `The ${providerId} provider cannot propose a change.`,
		};
	}
	if (intent.withReviewers === true && capabilities.reviewersAt === "never") {
		return {
			ok: false,
			reason: `The ${providerId} provider has no notion of requested reviewers.`,
			instead: "Propose the change, then ask people to look at it yourself.",
		};
	}
	return { ok: true };
}

/** Retargeting, which is not the same operation on every backend. */
function retargetable(
	capabilities: AuthoringCapabilities,
	providerId: string,
): Offerable {
	if (capabilities.retarget === "change") return { ok: true };
	if (capabilities.retarget === "stack") {
		return {
			ok: false,
			reason: `On ${providerId} a change's base is not set on the change. Retargeting is a stack operation there, so moving one change means resubmitting the stack it sits in.`,
			instead:
				"Restack locally so the change sits on the base you want, then submit the stack.",
		};
	}
	return {
		ok: false,
		reason: `The ${providerId} provider cannot change what a proposal targets.`,
		instead:
			"Close this change and propose it again against the base you want.",
	};
}

/** Requesting reviewers after the fact, which one backend will not do. */
function reviewable(
	capabilities: AuthoringCapabilities,
	providerId: string,
): Offerable {
	if (capabilities.reviewersAt === "any-time") return { ok: true };
	if (capabilities.reviewersAt === "creation") {
		return {
			ok: false,
			reason: `The ${providerId} provider takes reviewers only as a change is created.`,
			instead:
				"Name the reviewers when proposing. On an existing change, ask them directly instead.",
		};
	}
	return {
		ok: false,
		reason: `The ${providerId} provider has no notion of requested reviewers.`,
		instead: "Ask people to look at it yourself.",
	};
}

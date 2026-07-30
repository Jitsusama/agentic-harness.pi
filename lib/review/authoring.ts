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

/** Something a caller wants to do to a proposal. */
export interface AuthoringIntent {
	kind:
		| "propose"
		| "propose-stack"
		| "retarget"
		| "set-draft"
		| "close"
		| "reopen"
		| "merge"
		| "request-reviewers";
	/** Naming reviewers as part of proposing. */
	withReviewers?: boolean;
	/** Whether the change is currently queued to merge. */
	enqueued?: boolean;
}

/** Whether it will work, and what to do instead when it will not. */
export type Offerable =
	| { ok: true }
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
	if (
		intent.enqueued === true &&
		capabilities.refusesWhileEnqueued &&
		MUTATES.has(intent.kind)
	) {
		return {
			ok: false,
			reason: `This change is queued to merge, and on ${providerId} changing it now ejects it from the queue along with everything speculatively batched with it. Re-running the checks for the rest is measured in hundreds of jobs.`,
			instead:
				"Cancel the merge, make the change, and queue it again, or wait for it to land.",
		};
	}

	switch (intent.kind) {
		case "propose":
			return proposable(intent, capabilities, providerId);
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

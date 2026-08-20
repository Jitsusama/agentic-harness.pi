/**
 * Objecting to a publish that would eject a queued change.
 *
 * The working layer asks before it pushes, because the reason not to push is
 * often something only the hosting layer knows. This is that answer. On a
 * backend with a merge queue, pushing to a queued branch ejects it and
 * everything speculatively batched with it, and re-running the checks for the
 * rest is measured in hundreds of jobs. Nothing in `lib/work` knows what a queue
 * is, and it should not: the layer that knows why is the layer that explains it.
 *
 * The whole thing is best-effort by design. Resolving a branch to a change means
 * asking a backend, which can be slow, unauthenticated, or simply wrong about a
 * branch that has no change at all. None of those may stop a push. A person who
 * cannot publish because a review provider is having a bad day would rightly
 * disable this, and then it would protect nobody.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { queueRefusal } from "@jitsusama/agentic-harness.core/review";
import type { PublishReview } from "@jitsusama/agentic-harness.core/work";
import { WORK_PUBLISH_CHECK } from "@jitsusama/agentic-harness.core/work";
import { reviewEngine } from "./engine.js";

/**
 * Listen for publishes and object when one would eject a queued change.
 *
 * Registered unconditionally. There is nothing to negotiate: either the working
 * layer asks, in which case this answers, or nothing asks and this costs
 * nothing.
 */
export function guardPublishes(pi: ExtensionAPI): void {
	pi.events.on(WORK_PUBLISH_CHECK, (raw: unknown) => {
		const asked = raw as Partial<PublishReview> & {
			waitFor?: (work: Promise<unknown>) => void;
		};
		if (asked.intent === undefined || typeof asked.object !== "function") {
			return;
		}
		// Handed back so the asker waits for the answer rather than guessing how
		// long a backend takes. Without this the check races the push it is
		// meant to gate, which is worse than not checking: it would pass most
		// of the time and fail exactly when the backend was slow.
		asked.waitFor?.(objectIfQueued(pi, asked as PublishReview));
	});
}

/**
 * Look the branch up as a change, and object if it is queued.
 *
 * A branch name is a reference the resolver already understands, so this goes
 * through the same route every other lookup here does rather than growing a
 * second one. Resolved against the tree being pushed from, which is what lets a
 * provider recognize the repo at all.
 *
 * Every failure path is a silent return. A branch with no change is the normal
 * case for the first push of a new branch, and a backend that will not answer is
 * a reason to know less, not a reason to refuse.
 */
async function objectIfQueued(
	pi: ExtensionAPI,
	asked: PublishReview,
): Promise<void> {
	try {
		const { engine } = await reviewEngine(pi);
		const bound = await engine.resolve(
			asked.intent.branch,
			asked.intent.treePath,
		);
		const proposal = await bound.proposal();
		if (!proposal) return;

		const refusal = queueRefusal(proposal.queue, bound.provider.id);
		if (refusal !== undefined) {
			asked.object({
				from: bound.provider.id,
				reason: refusal.reason,
				...(refusal.instead === undefined ? {} : { instead: refusal.instead }),
			});
			return;
		}

		// A backend can know it refuses to touch a queued change and still be
		// unable to say whether this one is queued. Meteorite is exactly that:
		// Merge Garden is a separate service and the pull route carries no
		// posture, which is an honest silence rather than an omission.
		//
		// Blocking on it would refuse every push on the backend where the hazard
		// is worst, so this cautions instead. Saying nothing was the other
		// option and is worse: the cost of being wrong here is somebody else's
		// batch, measured in hundreds of jobs, and a person who knows they did
		// not queue it loses nothing by reading one line.
		if (
			bound.capabilities.authoring?.refusesWhileEnqueued === true &&
			proposal.queue === undefined &&
			proposal.state === "open"
		) {
			asked.object({
				from: bound.provider.id,
				blocking: false,
				reason: `${bound.provider.id} ejects a change from its merge queue when the branch moves, and does not report whether this one is queued.`,
				instead:
					"If it is queued, cancel the merge before pushing: ejecting it takes everything batched with it, and re-running their checks is measured in hundreds of jobs.",
			});
		}
	} catch {
		// Knowing less is the cost. Refusing a push because a lookup failed
		// would make this the first thing anybody turned off.
	}
}

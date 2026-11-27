/**
 * Whether a draft may be marked ready: the repo's own ready gate, named in
 * `review.ready.gates` and run with the head's full sha (merge-gate.ts).
 *
 * Apart from `offer.ts` because, as a merge's gate is, it is a guard over
 * the repo's own say, read from the head the backend reports rather than
 * from the checkout, which may stand anywhere.
 */

import type { BoundTarget } from "../../../lib/core/review/index.ts";
import { gateFor, gateRefusal } from "../merge-gate.ts";
import type { MergeGating } from "./offer-merge.ts";
import type { hostedChange } from "./shared.ts";

/** What a ready gate says left the change: a draft. */
const LEFT = "Left as a draft";

/**
 * Why `change` may not be marked ready yet, or nothing when its repo names
 * no ready gate or the gate lets its head through. The head is read again
 * once the gate has spoken, so a push while it ran is refused rather than
 * readied on the strength of a head nobody gated.
 */
export async function readyRefusal(
	gating: MergeGating,
	bound: BoundTarget,
	change: NonNullable<ReturnType<typeof hostedChange>>,
): Promise<string | undefined> {
	if (gating.unread !== undefined) {
		return `${gating.unread.replace(/\.$/, "")}. So whether ${change.repo.key} names a ready gate can't be known. ${LEFT}; mend the file, then mark it ready again.`;
	}
	const gate = gateFor(gating.review, change.repo.key, "ready");
	if (gate.kind === "none") return undefined;
	if (gate.kind === "malformed") return `${gate.problem} ${LEFT}.`;
	const head = (await bound.proposal())?.headCommit;
	if (!head) {
		return `${change.repo.key} has a ready gate, \`${gate.command}\`, but ${bound.provider.id} doesn't report the head of ${change.label}, so no gate can be held to one. ${LEFT}.`;
	}
	const refused = await gateRefusal(
		gate,
		head,
		gating.cwd,
		gating.run,
		"ready",
	);
	if (refused !== undefined) return refused;
	const now = (await bound.proposal())?.headCommit;
	if (now !== head) {
		return `${change.label} moved from ${head.slice(0, 12)} to ${now?.slice(0, 12) ?? "a head its backend didn't report"} while its ready gate ran. ${LEFT}; mark it ready again to gate the new head.`;
	}
	return undefined;
}

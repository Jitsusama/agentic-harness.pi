/**
 * The `review_say` tool: saying something, now.
 *
 * This is the flow an author lives in on their own change, and
 * it is deliberately ceremony-free: reply, resolve, react. The
 * ceremony belongs to `review_draft`, which composes a whole
 * review rather than answering one remark, and the overlap
 * between the two is kept on purpose: answering one comment and
 * composing a review that happens to answer it are different
 * acts, and forcing the first through a draft would be ceremony
 * for its own sake.
 *
 * Reading the conversation belongs to `review_see`. This tool
 * only writes, so every action here asks first.
 *
 * What a call does, loaded on its first call; the registration is
 * `say-tool.ts`. What each action does, and what its gate shows,
 * lives in `batch.ts`, because the singular parameters are read as a
 * batch of one and both go down the same road.
 */

import type {
	ExtensionAPI,
	ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import type { BoundTarget } from "../../../lib/core/review/index.ts";
import { sessionCwd } from "../../../lib/core/session/index.ts";
import { MERGE_COMMAND, noteQueued } from "../queued.ts";
import { batchRefusal, runBatch, type SayItem } from "./batch.ts";
import type { SayParams } from "./say-tool.ts";
import {
	type Answer,
	boundFor,
	hostedChange,
	refuse,
	refuseFailure,
	threadsOf,
} from "./shared.ts";
import { isRefusal } from "./view.ts";

/** The action a `/merge` comment is said through. */
const COMMENTING = "comment";

/** Whether an item comments the command that queues a change to merge. */
function asksToMerge(item: SayItem): boolean {
	return item.action === COMMENTING && MERGE_COMMAND.test(item.body ?? "");
}

/**
 * Do what a `review_say` call asks: read the singular parameters as
 * a batch of one and send the batch down the one road (`batch.ts`).
 */
export async function saySomething(
	pi: ExtensionAPI,
	params: SayParams,
	ctx: ExtensionToolContext,
): Promise<Answer> {
	// Held outside the try so a failure can say which provider was asked.
	let bound: BoundTarget | undefined;
	try {
		bound = await boundFor(pi, params, sessionCwd(ctx));
		const conversation = bound.conversation;
		const change = hostedChange(bound);
		if (!conversation || !change) {
			return refuse(
				"Nothing hosts this target, so it has no conversation. Compose a review with review_draft and render it as a document.",
			);
		}

		const cannot = batchRefusal(params as Record<string, unknown>);
		if (cannot) return refuse(cannot);
		if (!params.action && !params.items) {
			return refuse("Say what to do: an action, or a batch of items.");
		}

		// The singular parameters are read as a batch of one, so there is
		// one road through this tool rather than two that agree today.
		const items = (params.items as SayItem[] | undefined) ?? [
			params as SayItem,
		];

		// One read of the conversation for the whole call, so [T26] cannot
		// mean two different threads inside one gate. Skipped entirely
		// when nothing in the batch refers to a thread.
		const threads = items.some((one) => one.thread !== undefined)
			? await threadsOf(bound)
			: [];

		const answer = await runBatch(
			ctx,
			bound,
			conversation,
			change,
			threads,
			items,
		);
		// A `/merge` comment sends the change to World's queue, which
		// merges it later, so it is watched until it lands (queued.ts).
		if (!isRefusal(answer.details) && items.some(asksToMerge)) {
			noteQueued(change);
		}
		return answer;
	} catch (error) {
		return refuseFailure(error, bound);
	}
}

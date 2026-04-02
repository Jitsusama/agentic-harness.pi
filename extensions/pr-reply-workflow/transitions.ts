/**
 * PR Reply transitions: context injection and stale context
 * filtering. Provides the agent with awareness of the current
 * PR reply session when active.
 */

import { filterContext } from "../../lib/internal/state.js";
import { type PRReplyState, threadsForReview } from "./state.js";

/** Custom message type for PR reply context. */
const CONTEXT_TYPE = "pr-reply-context";

/**
 * Build context for the agent's system prompt when PR reply
 * mode is active. Tells the agent which PR we're working on,
 * where we are in the review, and what thread states look like.
 */
export function injectReplyGuidance(state: PRReplyState) {
	if (!state.enabled) return;

	const parts: string[] = [];

	parts.push("[PR Reply Mode Active]");

	if (state.prNumber && state.owner && state.repo) {
		parts.push(`PR: ${state.owner}/${state.repo}#${state.prNumber}`);
	}

	const totalThreads = state.threads.length;
	if (totalThreads > 0) {
		const pending = countByState(state, "pending");
		const replied = countByState(state, "replied");
		const passed = countByState(state, "passed");
		const implementing = countByState(state, "implementing");

		parts.push(
			`Progress: ${replied}/${totalThreads} replied, ${pending} pending, ${passed} passed, ${implementing} implementing`,
		);

		const review = state.reviews[state.reviewIndex];
		if (review) {
			const reviewThreads = threadsForReview(review, state.threads);
			const currentThread = reviewThreads[state.threadIndexInReview];
			if (currentThread) {
				parts.push(
					`Current: ${currentThread.file}:${currentThread.line} (${currentThread.reviewState})`,
				);
			}
		}
	}

	if (state.awaitingTDDCompletion) {
		parts.push("Awaiting TDD completion for current thread");
	}

	return {
		message: {
			customType: CONTEXT_TYPE,
			content: parts.join(" | "),
			display: false,
		},
	};
}

/**
 * Create a context filter that removes stale PR reply context
 * when the mode is not active.
 */
export function pruneStaleReplyGuidance(state: PRReplyState) {
	return filterContext(CONTEXT_TYPE, () => state.enabled);
}

/** Count threads in a given state. */
function countByState(state: PRReplyState, threadState: string): number {
	return state.threads.filter((t) => t.status === threadState).length;
}

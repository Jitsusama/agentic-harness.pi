/**
 * PR Review transitions — context injection and stale context
 * filtering. Provides the agent with awareness of the current
 * PR review session when active.
 */

import { filterContext } from "../lib/state.js";
import { commentsByStatus, type PRReviewState } from "./state.js";

/** Custom message type for PR review context. */
const CONTEXT_TYPE = "pr-review-context";

/**
 * Build context for the agent's system prompt when PR review
 * mode is active. Tells the agent which PR we're reviewing,
 * what phase we're in, and the current comment stats.
 */
export function buildPRReviewContext(state: PRReviewState) {
	if (!state.enabled || !state.session) return;

	const { pr, worktreePath, previousReview } = state.session;

	const parts: string[] = [];
	parts.push("[PR Review Active]");
	parts.push(`PR: ${pr.owner}/${pr.repo}#${pr.number}`);
	parts.push(`Phase: ${state.phase}`);

	const total = state.session.comments.length;
	if (total > 0) {
		const accepted = commentsByStatus(state.session, "accepted").length;
		const draft = commentsByStatus(state.session, "draft").length;
		parts.push(`Comments: ${total} (${accepted} accepted, ${draft} draft)`);
	}

	if (worktreePath) {
		parts.push(`Worktree: ${worktreePath}`);
	}

	if (previousReview) {
		const open = previousReview.threads.filter((t) => !t.isResolved).length;
		parts.push(`Re-review: ${open} open previous threads`);
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
 * Create a context filter that removes stale PR review context
 * when the mode is not active.
 */
export function prReviewContextFilter(state: PRReviewState) {
	return filterContext(CONTEXT_TYPE, () => state.enabled);
}

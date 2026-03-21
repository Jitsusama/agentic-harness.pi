/**
 * PR Review transitions: context injection and stale context
 * filtering. Provides the agent with awareness of the current
 * PR review session when active.
 *
 * Stubbed: populated in M14 (lifecycle).
 */

import { filterContext } from "../lib/state.js";
import { commentStats, type PRReviewState } from "./state.js";

/** Custom message type for PR review context. */
const CONTEXT_TYPE = "pr-review-context";

/**
 * Build context for the agent's system prompt when PR review
 * mode is active. Tells the agent which PR we're reviewing,
 * what phase we're in, and the current comment stats.
 */
export function buildPRReviewContext(state: PRReviewState) {
	if (!state.enabled || !state.session) return;

	const { pr, phase, repoPath } = state.session;

	const parts: string[] = [];
	parts.push("[PR Review Active]");
	parts.push(`PR: ${pr.owner}/${pr.repo}#${pr.number}`);
	parts.push(`Phase: ${phase}`);

	const stats = commentStats(state.session);
	const total = stats.pending + stats.approved + stats.rejected;
	if (total > 0) {
		parts.push(
			`Comments: ${total} (${stats.approved} approved, ${stats.pending} pending)`,
		);
	}

	parts.push(`Repo: ${repoPath}`);

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

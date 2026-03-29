/**
 * Handles PR review transitions: injects context into the
 * system prompt so the agent knows about the active review
 * session, and filters out stale context messages.
 */

import { filterContext } from "../../lib/internal/state.js";
import { commentStats, type PRReviewState } from "./state.js";

/** Custom message type for PR review context. */
const CONTEXT_TYPE = "pr-review-context";

/**
 * Build context for the agent's system prompt when PR review
 * mode is active. Tells the agent which PR we're reviewing,
 * what phase we're in, and the current comment stats.
 */
export function injectReviewGuidance(state: PRReviewState) {
	if (!state.enabled || !state.session) return;

	const { pr, phase, repoPath } = state.session;

	const parts: string[] = [];
	parts.push("[PR Review Active]");
	parts.push(`PR: ${pr.owner}/${pr.repo}#${pr.number}`);
	parts.push(`Phase: ${phase}`);

	const stats = commentStats(state.session);
	const total =
		stats.proposed + stats.pending + stats.approved + stats.rejected;
	if (total > 0) {
		if (stats.proposed > 0) {
			parts.push(
				`Comments: ${total} (${stats.proposed} proposed, ${stats.approved} approved, ${stats.pending} pending)`,
			);
		} else {
			parts.push(
				`Comments: ${total} (${stats.approved} approved, ${stats.pending} pending)`,
			);
		}
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
export function pruneStaleReviewGuidance(state: PRReviewState) {
	return filterContext(CONTEXT_TYPE, () => state.enabled);
}

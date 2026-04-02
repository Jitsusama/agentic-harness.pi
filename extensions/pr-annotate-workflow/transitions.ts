/**
 * Context injection for the annotation workflow: tells the
 * agent about the active session so it knows which PR is
 * being annotated and the current comment stats.
 */

import { filterContext } from "../../lib/internal/state.js";
import { commentStats } from "./state.js";
import type { PRAnnotateState } from "./types.js";

/** Custom message type for annotation context. */
const CONTEXT_TYPE = "pr-annotate-context";

/**
 * Build context for the agent's system prompt when
 * annotation mode is active.
 */
export function injectAnnotateGuidance(state: PRAnnotateState) {
	if (!state.enabled || !state.session) return;

	const { pr, repo } = state.session;
	const stats = commentStats(state.session);
	const total = stats.pending + stats.approved + stats.rejected;

	const parts: string[] = [];
	parts.push("[PR Annotate Active]");
	parts.push(`PR: ${repo ? `${repo}#` : "#"}${pr}`);
	if (total > 0) {
		parts.push(
			`Comments: ${total} (${stats.approved} approved, ${stats.pending} pending, ${stats.rejected} rejected)`,
		);
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
 * Create a context filter that removes stale annotation
 * context when the mode is not active.
 */
export function pruneStaleAnnotateGuidance(state: PRAnnotateState) {
	return filterContext(CONTEXT_TYPE, () => state.enabled);
}

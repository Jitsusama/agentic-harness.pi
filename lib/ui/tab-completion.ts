/**
 * Tab completion tracking: reusable tabStatus/allComplete
 * callbacks for workspace prompts.
 *
 * All three PR workflow workspaces duplicate this pattern:
 * build a tabIds array, maintain a "passed" predicate, and
 * wire up tabStatus/allComplete callbacks. This helper
 * extracts the shared logic.
 */

import type { TabStatus } from "./types.js";

/** Callbacks expected by WorkspacePromptConfig. */
export interface TabCompletionCallbacks {
	tabStatus: (index: number) => TabStatus;
	allComplete: () => boolean;
}

/**
 * Build tabStatus/allComplete callbacks from a tab ID list
 * and a "passed" predicate.
 *
 * @param tabIds - ordered tab identifiers matching workspace items
 * @param isPassed - returns true when a tab is complete
 * @param completableIds - subset of tabIds that count toward
 *   allComplete (defaults to all tabIds). Use this to exclude
 *   tabs like "summary" that are always pending.
 */
export function tabCompletion(
	tabIds: readonly string[],
	isPassed: (tabId: string) => boolean,
	completableIds?: readonly string[],
): TabCompletionCallbacks {
	const checkIds = completableIds ?? tabIds;

	return {
		tabStatus: (index: number): TabStatus => {
			const tabId = tabIds[index];
			if (!tabId) return "pending";
			return isPassed(tabId) ? "complete" : "pending";
		},
		allComplete: () => checkIds.every((id) => isPassed(id)),
	};
}

/**
 * Runtime state container for the PR review extension.
 * Types and manipulation live in model.ts; this file
 * holds the state shape and lifecycle functions.
 */

// Re-export everything from model so existing consumers
// can keep importing from state.ts during migration.
export * from "./model.js";

import type { PRTarget, ReviewSession } from "./model.js";

/** Runtime state for the PR review extension. */
export interface PRReviewState {
	enabled: boolean;
	session: ReviewSession | null;
}

/** Create the initial state. */
export function createState(): PRReviewState {
	return {
		enabled: false,
		session: null,
	};
}

/** Reset state to defaults. */
export function resetState(state: PRReviewState): void {
	state.enabled = false;
	state.session = null;
}

/** Create a new review session. */
export function createSession(pr: PRTarget, repoPath: string): ReviewSession {
	return {
		pr,
		context: null,
		repoPath,
		worktreePath: null,
		synopsis: "",
		scopeAnalysis: "",
		comments: [],
		tabStates: new Map(),
		reviewBody: "",
		verdict: "COMMENT",
		phase: "gathering",
	};
}

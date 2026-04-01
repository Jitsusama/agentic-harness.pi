/**
 * Defines the runtime state shape for plan mode, along with
 * sensible defaults and constants used throughout the extension.
 */

import { DEFAULT_PLAN_DIR } from "../../lib/internal/state.js";
import type { PlanWorktree } from "./worktree.js";

/** Runtime state for plan mode. */
export interface PlanState {
	enabled: boolean;
	planDir: string;
	wroteToPlanDir: boolean;
	savedTools: string[] | null;
	/** Worktrees created for this plan, one per repository. */
	worktrees: PlanWorktree[];
	/** Absolute path to the most recently written plan file. */
	lastPlanFile: string | null;
}

/** Tools available during plan mode (read-only + plan-dir writes). */
export const PLAN_TOOLS = [
	"read",
	"write",
	"bash",
	"grep",
	"find",
	"ls",
	"ask",
	"plan_mode",
	"plan_interview",
	"slack",
	"google",
	"web_search",
	"web_read",
	"vault",
];

/** Git-mutating bash commands: blocked in plan mode. */
export const GIT_MUTATING =
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|stash|cherry-pick|revert|tag)\b/i;

/** Create the initial plan mode state. */
export function createPlanState(): PlanState {
	return {
		enabled: false,
		planDir: DEFAULT_PLAN_DIR,
		wroteToPlanDir: false,
		savedTools: null,
		worktrees: [],
		lastPlanFile: null,
	};
}

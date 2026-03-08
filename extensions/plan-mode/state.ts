/**
 * Plan mode state — shape, defaults, and constants.
 */

export interface PlanState {
	enabled: boolean;
	planDir: string;
	wroteToPlanDir: boolean;
	savedTools: string[] | null;
}

export const DEFAULT_PLAN_DIR = ".pi/plans";

export const PLAN_TOOLS = [
	"read",
	"write",
	"bash",
	"grep",
	"find",
	"ls",
	"ask",
];

/** Git-mutating bash commands — blocked in plan mode. */
export const GIT_MUTATING =
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|stash|cherry-pick|revert|tag)\b/i;

export function createPlanState(): PlanState {
	return {
		enabled: false,
		planDir: DEFAULT_PLAN_DIR,
		wroteToPlanDir: false,
		savedTools: null,
	};
}

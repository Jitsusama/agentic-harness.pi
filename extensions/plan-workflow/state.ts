/**
 * Runtime state for the plan workflow. This is a cache derived
 * from the plan document, which is the real source of truth: the
 * stage and the displayed detail are refreshed from the document
 * on every transition and on restore. Nothing here is
 * authoritative on its own.
 */

import type { Stage } from "./machine.js";

/** The in-memory view of the active plan. */
export interface PlanState {
	/** Current stage, mirrored from the document's front-matter. */
	stage: Stage;
	/** Absolute path to the active plan document, or null when none. */
	planPath: string | null;
	/** The active plan's id, mirrored for quick reference. */
	planId: string | null;
	/** The active plan's title (its H1), for the widget. */
	title: string | null;
	/** Checkbox progress from the document body, for the widget. */
	done: number;
	total: number;
}

/** Git-mutating bash commands: blocked while planning. */
export const GIT_MUTATING =
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|stash|cherry-pick|revert|tag)\b/i;

/** A fresh, idle plan state with nothing attached. */
export function createPlanState(): PlanState {
	return {
		stage: "idle",
		planPath: null,
		planId: null,
		title: null,
		done: 0,
		total: 0,
	};
}

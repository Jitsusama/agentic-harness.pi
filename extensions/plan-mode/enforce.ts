/**
 * Plan mode enforcement — tool_call interception logic.
 *
 * Blocks writes outside the plan directory and git-mutating
 * commands. Allows reads, searches, and plan-dir writes.
 */

import * as path from "node:path";
import type { PlanState } from "./state.js";
import { GIT_MUTATING } from "./state.js";

/**
 * Check a tool call against plan mode restrictions.
 * Returns a block result if the action is disallowed.
 */
export function enforcePlanMode(
	state: PlanState,
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
): { block: true; reason: string } | undefined {
	if (!state.enabled) return;

	if (toolName === "write" || toolName === "edit") {
		const filePath = String(input.path ?? "");
		const resolved = path.resolve(cwd, filePath);
		const resolvedPlanDir = path.resolve(cwd, state.planDir);
		const inPlanDir =
			resolved.startsWith(resolvedPlanDir + path.sep) ||
			resolved === resolvedPlanDir;

		if (inPlanDir) {
			state.wroteToPlanDir = true;
			return;
		}

		return {
			block: true,
			reason: `Plan mode: writes restricted to ${state.planDir}/. Exit with /plan first.`,
		};
	}

	if (toolName === "bash" && GIT_MUTATING.test(String(input.command ?? ""))) {
		return {
			block: true,
			reason: "Plan mode: git-mutating command blocked. Exit with /plan first.",
		};
	}
}

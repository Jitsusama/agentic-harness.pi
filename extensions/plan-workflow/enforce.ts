/**
 * Stage-aware enforcement. While a plan is in its read-only
 * stages (think and plan), the agent may not implement: code
 * writes and git-mutating commands are blocked, with the one
 * exception of writing the active plan document. Once the plan
 * moves to build, everything is allowed. idle and the terminal
 * stages do not interfere at all.
 *
 * This blocks the agent, never the human: it returns an
 * agent-facing reason, never a prompt. It is the one thing the
 * workflow guards, and it is what "do not implement while we are
 * still thinking" means in practice.
 */

import * as path from "node:path";
import type { ToolCallEventResult } from "@mariozechner/pi-coding-agent";
import { GIT_MUTATING, type PlanState } from "./state.js";

/** Whether a stage forbids implementation (code writes, git mutation). */
function isReadOnly(stage: PlanState["stage"]): boolean {
	return stage === "think" || stage === "plan";
}

/**
 * Whether a tool call is an edit or write that targets the active
 * plan document. Shared by enforcement (which allows it through
 * the read-only guard) and the live-refresh trigger (which
 * repaints the scoreboard when the document changes).
 */
export function isPlanDocWrite(
	toolName: string,
	input: Record<string, unknown>,
	planPath: string | null,
	cwd: string,
): boolean {
	if (!planPath) return false;
	if (toolName !== "write" && toolName !== "edit") return false;
	const resolved = path.resolve(cwd, String(input.path ?? ""));
	return resolved === path.resolve(planPath);
}

/** Check a tool call against the active stage's restrictions. */
export function enforcePlan(
	state: PlanState,
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
): ToolCallEventResult | undefined {
	if (!isReadOnly(state.stage)) return;

	if (toolName === "write" || toolName === "edit") {
		if (isPlanDocWrite(toolName, input, state.planPath, cwd)) return;
		return {
			block: true,
			reason: `Plan workflow (${state.stage}): writes are limited to the plan document. Move to build to implement.`,
		};
	}

	if (toolName === "bash" && GIT_MUTATING.test(String(input.command ?? ""))) {
		return {
			block: true,
			reason: `Plan workflow (${state.stage}): git-mutating command blocked. Move to build first.`,
		};
	}
}

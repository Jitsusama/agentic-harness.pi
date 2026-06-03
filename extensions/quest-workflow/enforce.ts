/**
 * Stage-aware enforcement for the focused document. The
 * machine only blocks when the focused document is a plan
 * in `think` or `draft`; other document kinds (research,
 * brief, report) have no implementation phase and never
 * block code writes.
 *
 * The exception in all cases: writes that target the
 * focused document itself are allowed (otherwise the author
 * could not draft it).
 *
 * This blocks the agent, never the human. It returns an
 * agent-facing reason, never a prompt.
 */

import * as path from "node:path";
import type { ToolCallEventResult } from "@mariozechner/pi-coding-agent";
import { listTreesOnQuest } from "../../lib/internal/quest/trees.js";
import { GIT_MUTATING, type QuestState } from "./state.js";

const DOC_SUBDIRS = ["plans", "research", "briefs", "reports"];

function isReadOnly(state: QuestState): boolean {
	if (state.documentKind !== "plan") return false;
	return state.documentStage === "think" || state.documentStage === "draft";
}

/** Whether the tool call targets the focused document itself. */
export function isFocusedDocWrite(
	toolName: string,
	input: Record<string, unknown>,
	documentPath: string | null,
	cwd: string,
): boolean {
	if (!documentPath) return false;
	if (toolName !== "write" && toolName !== "edit") return false;
	const resolved = path.resolve(cwd, String(input.path ?? ""));
	return resolved === path.resolve(documentPath);
}

/**
 * Whether the write target lives under the loaded quest's
 * own directory (the README or any document subdir). Such
 * writes are always considered "on the quest itself" and
 * don't trigger the no-tree guardian.
 */
function isQuestInternalWrite(
	input: Record<string, unknown>,
	questDir: string | null,
	cwd: string,
): boolean {
	if (!questDir) return false;
	const resolved = path.resolve(cwd, String(input.path ?? ""));
	const questResolved = path.resolve(questDir);
	if (resolved === path.join(questResolved, "README.md")) return true;
	return DOC_SUBDIRS.some((sub) =>
		resolved.startsWith(`${path.join(questResolved, sub)}${path.sep}`),
	);
}

/**
 * Reactive guardian: when the loaded quest is
 * code-bearing (has a focused build-stage plan) but no
 * tree, block writes to anything outside the quest's own
 * directory. Pushes the agent back to `tree-add`.
 */
function enforceNoTree(
	state: QuestState,
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
): ToolCallEventResult | undefined {
	if (toolName !== "write" && toolName !== "edit") return;
	if (!state.questDir || !state.questId) return;
	if (state.documentKind !== "plan" || state.documentStage !== "build") return;
	if (isQuestInternalWrite(input, state.questDir, cwd)) return;
	const listing = listTreesOnQuest(state.questDir);
	if (!listing.ok) return;
	if (listing.trees.length > 0) return;
	return {
		block: true,
		reason:
			"Quest workflow: this quest is in build with no working tree. Run `tree-add` to scaffold one before editing code outside the quest's own directory.",
	};
}

/** Check a tool call against the focused document's discipline. */
export function enforceQuest(
	state: QuestState,
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
): ToolCallEventResult | undefined {
	if (isReadOnly(state)) {
		if (toolName === "write" || toolName === "edit") {
			if (isFocusedDocWrite(toolName, input, state.documentPath, cwd)) return;
			return {
				block: true,
				reason: `Quest workflow (plan ${state.documentStage}): writes are limited to the plan document. Move to build to implement.`,
			};
		}

		if (toolName === "bash" && GIT_MUTATING.test(String(input.command ?? ""))) {
			return {
				block: true,
				reason: `Quest workflow (plan ${state.documentStage}): git-mutating command blocked. Move to build first.`,
			};
		}
	}

	return enforceNoTree(state, toolName, input, cwd);
}

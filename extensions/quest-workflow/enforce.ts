/**
 * Stage-aware enforcement for the focused document, driven by the
 * write classifier. The gate's job is to keep the agent in the
 * right phase and to keep quest code in a real working tree, never
 * to corner a legitimate write.
 *
 * During a plan's think or draft stage, writes to the plan itself,
 * to the quest's own directory, to scratch and to brand-new files
 * flow freely; only edits to already-tracked code defer to build.
 * During build, any write that lands inside a git working tree is
 * allowed (that is a code home, whether or not the quest has
 * registered it); only a genuinely homeless write is blocked, with
 * a satisfiable remedy.
 *
 * This blocks the agent, never the human. It returns an
 * agent-facing reason, never a prompt.
 */

import { tmpdir } from "node:os";
import * as path from "node:path";
import type { ToolCallEventResult } from "@mariozechner/pi-coding-agent";
import {
	bashWriteTargets,
	classifyBashWrite,
} from "../../lib/internal/quest/bash-write.js";
import {
	canonicalPath,
	gitTreeRootOf,
	isGitignored,
	isTracked,
} from "../../lib/internal/quest/git-signals.js";
import {
	classifyWrite,
	type WriteClassification,
} from "../../lib/internal/quest/write-classifier.js";
import type { QuestState } from "./state.js";

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

// Path canonicalization is shared with the prune guards; see
// canonicalPath in git-signals.
const canonical = canonicalPath;

/** Tunable inputs to the gate, so tests can vary the scratch roots. */
export interface EnforceOptions {
	/** Directories whose contents are always scratch. Defaults to the temp dir. */
	scratchRoots?: string[];
}

/** Classify a write target against the loaded quest and git signals. */
function classifyTarget(
	state: QuestState,
	absTarget: string,
	options: EnforceOptions,
): WriteClassification {
	const roots = (options.scratchRoots ?? [tmpdir()]).map(canonical);
	return classifyWrite(canonical(absTarget), {
		questDir: state.questDir ? canonical(state.questDir) : null,
		scratchRoots: roots,
		isGitignored,
		isTracked,
		gitTreeRootOf,
	});
}

/**
 * The plan-phase write gate: in think or draft, defer only edits to
 * already-tracked code. The plan document, quest-internal files,
 * scratch and brand-new (untracked) files all flow, so drafting and
 * scratch exploration are never cornered.
 */
function enforcePhase(
	state: QuestState,
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
	options: EnforceOptions,
): ToolCallEventResult | undefined {
	if (toolName === "write" || toolName === "edit") {
		if (isFocusedDocWrite(toolName, input, state.documentPath, cwd)) return;
		const target = path.resolve(cwd, String(input.path ?? ""));
		if (classifyTarget(state, target, options).category === "tracked-code") {
			return {
				block: true,
				reason: `Quest workflow (plan ${state.documentStage}): this edits already-tracked code. Move to build to implement, or keep planning notes in the plan, the quest directory or a scratch path.`,
			};
		}
		return;
	}

	if (toolName === "bash") {
		const command = String(input.command ?? "");
		const kind = classifyBashWrite(command);
		if (kind === "git-mutating") {
			return {
				block: true,
				reason: `Quest workflow (plan ${state.documentStage}): git-mutating command blocked. Move to build first.`,
			};
		}
		if (kind === "bash-write") {
			const lands = bashWriteTargets(command)
				.map(
					(t) => classifyTarget(state, path.resolve(cwd, t), options).category,
				)
				.some((category) => category === "tracked-code");
			if (lands) {
				return {
					block: true,
					reason: `Quest workflow (plan ${state.documentStage}): this bash write targets already-tracked code. Move to build first, or redirect to a scratch path. Use the write/edit tools for normal edits.`,
				};
			}
		}
	}

	return;
}

/**
 * The build-phase home gate: a quest in build keeps its code in a
 * working tree. Any write inside a git tree is a code home and is
 * allowed, which is the fix for the cornering the old gate caused
 * (it stood down only for a registered tree or a still-active
 * session, so an in-tree write from a detached session was blocked
 * even though the tree was right there). Only a genuinely homeless
 * write -- outside every git tree, and not scratch or quest-internal
 * -- is blocked, with a satisfiable remedy.
 *
 * This is advisory, and it fails open: if the home directory is
 * itself a git repository (dotfiles under git, for instance), a
 * write there reads as in-tree and the block never fires. That is
 * acceptable for a nudge whose only job is to keep quest code in a
 * tree it can later prune, not to police the filesystem.
 */
function enforceHome(
	state: QuestState,
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
	options: EnforceOptions,
): ToolCallEventResult | undefined {
	if (!state.questDir || !state.questId) return;
	if (state.documentKind !== "plan" || state.documentStage !== "build") return;
	const homeless = (target: string): boolean =>
		classifyTarget(state, target, options).category === "loose-file";
	const block = (): ToolCallEventResult => ({
		block: true,
		reason:
			"Quest workflow: this quest is in build, but this write lands outside every git working tree. Run `tree-add` to scaffold one, or write inside a git tree this quest works in. Do not unload the quest to bypass this.",
	});
	if (toolName === "write" || toolName === "edit") {
		if (homeless(path.resolve(cwd, String(input.path ?? "")))) return block();
		return;
	}
	if (toolName === "bash") {
		// A bash redirect can land code just as a write tool can, so the
		// home gate must see it too; otherwise `cat > /outside/loose.ts`
		// slips the nudge the write tool would have caught.
		const command = String(input.command ?? "");
		const lands = bashWriteTargets(command).some((t) =>
			homeless(path.resolve(cwd, t)),
		);
		if (lands) return block();
	}
	return;
}

/** Check a tool call against the focused document's discipline. */
export function enforceQuest(
	state: QuestState,
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
	options: EnforceOptions = {},
): ToolCallEventResult | undefined {
	if (isReadOnly(state))
		return enforcePhase(state, toolName, input, cwd, options);
	return enforceHome(state, toolName, input, cwd, options);
}

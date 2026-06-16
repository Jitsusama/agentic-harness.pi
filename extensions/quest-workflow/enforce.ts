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

import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { ToolCallEventResult } from "@mariozechner/pi-coding-agent";
import {
	bashWriteTargets,
	classifyBashWrite,
} from "../../lib/internal/quest/bash-write.js";
import {
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

/**
 * Canonicalize for prefix comparison. A not-yet-written file cannot
 * be realpath'd directly, so resolve the longest existing ancestor
 * (which turns /var into /private/var on macOS) and re-append the
 * missing tail. The literal path survives a total failure.
 */
function canonical(p: string): string {
	const tail: string[] = [];
	let prefix = p;
	while (!existsSync(prefix)) {
		const parent = path.dirname(prefix);
		if (parent === prefix) return p;
		tail.unshift(path.basename(prefix));
		prefix = parent;
	}
	try {
		const real = realpathSync(prefix);
		return tail.length > 0 ? path.join(real, ...tail) : real;
	} catch {
		// realpath can fail on a broken symlink; the literal path is best.
		return p;
	}
}

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
 */
function enforceHome(
	state: QuestState,
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
	options: EnforceOptions,
): ToolCallEventResult | undefined {
	if (toolName !== "write" && toolName !== "edit") return;
	if (!state.questDir || !state.questId) return;
	if (state.documentKind !== "plan" || state.documentStage !== "build") return;
	const target = path.resolve(cwd, String(input.path ?? ""));
	if (classifyTarget(state, target, options).category === "loose-file") {
		return {
			block: true,
			reason:
				"Quest workflow: this quest is in build, but this write lands outside every git working tree. Run `tree-add` to scaffold one, or write inside a git tree this quest works in. Do not unload the quest to bypass this.",
		};
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

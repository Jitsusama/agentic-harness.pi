/**
 * The quest write gate: the record's rules, then stage-aware
 * enforcement for the focused document. The gate's job is to keep
 * each quest's record whole, the agent in the right phase and quest
 * code in a real working tree, never to corner a legitimate write.
 *
 * The record's rules hold in every quest folder, with or without a
 * quest loaded: a document is made by `quest draft` and changed by the
 * edit and write tools, nothing in the record is removed by hand, and
 * anything else a quest makes goes to its workspace or, when a document
 * cites it, to `attachments/`. They refuse only what the path decides;
 * the rest is found on disk after the write.
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

import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import type { ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import {
	bashWriteTargets,
	classifyBashWrite,
	resolveBashWrites,
} from "@jitsusama/agentic-harness.core/quest/bash-write";
import {
	judgeRecordWrite,
	type RecordWrite,
} from "@jitsusama/agentic-harness.core/quest/record-gate";
import {
	classifyWrite,
	type WriteClassification,
} from "@jitsusama/agentic-harness.core/quest/write-classifier";
import { cacheDir } from "../../lib/internal/paths.ts";
import {
	canonicalPath,
	gitTreeRootOf,
	isGitignored,
	isTracked,
	isWithin,
} from "../../lib/internal/quest/git-signals.ts";
import { ensureQuestScratchDir } from "../../lib/internal/quest/scratch.ts";
import { listTreesOnQuest } from "../../lib/internal/quest/trees.ts";
import type { QuestState } from "./state.ts";

function isReadOnly(state: QuestState): boolean {
	if (state.documentKind !== "plan") return false;
	return state.documentStage === "think" || state.documentStage === "draft";
}

/**
 * Whether the gate engages at all. It runs only while a plan is
 * focused in a working stage; with no plan focused the gate is
 * dormant and never funnels or blocks.
 */
function isGateActive(state: QuestState): boolean {
	if (state.documentKind !== "plan") return false;
	const stage = state.documentStage;
	return stage === "think" || stage === "draft" || stage === "build";
}

/** The destination paths a tool call writes to, resolved against cwd. */
function writeTargetsOf(
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
): string[] {
	if (toolName === "write" || toolName === "edit") {
		return [path.resolve(cwd, String(input.path ?? ""))];
	}
	if (toolName === "bash") {
		return bashWriteTargets(String(input.command ?? "")).map((t) =>
			path.resolve(cwd, t),
		);
	}
	return [];
}

/**
 * Funnel a write to bare system temp into the quest's managed
 * scratch directory. System temp is not reaped and leaks across
 * runs, so instead of allowing it the gate creates (on first need)
 * a quest-owned scratch dir under the OS temp dir and names it as
 * the place to redirect. Writes already inside that dir classify as
 * quest-scratch, not system-temp, so they flow.
 */
function systemTempFunnel(
	state: QuestState,
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
	options: EnforceOptions,
): ToolCallEventResult | undefined {
	if (!state.questDir || !state.questId) return;
	const hitsTemp = writeTargetsOf(toolName, input, cwd).some(
		(t) => classifyTarget(state, t, options).category === "system-temp",
	);
	if (!hitsTemp) return;
	const dir = ensureQuestScratchDir(
		state.questDir,
		state.questId,
		state.scratchDir,
	);
	state.scratchDir = dir;
	return {
		block: true,
		reason: `Quest workflow: this writes to system temp, which is not tracked or reaped. Redirect into this quest's managed scratch directory instead, which is cleaned up when the quest concludes: ${dir}`,
	};
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

/**
 * The system temp roots the gate funnels into the managed scratch
 * dir: the OS temp dir plus the conventional /tmp the agent reaches
 * for, which on macOS canonicalizes to /private/tmp. Deduped after
 * canonicalization so /tmp and its realpath do not double up.
 */
function defaultTempRoots(): string[] {
	const roots = [tmpdir(), "/tmp", "/private/tmp"].map(canonical);
	return [...new Set(roots)];
}

/** Tunable inputs to the gate, so tests can vary the temp roots. */
export interface EnforceOptions {
	/** System temp roots to funnel into managed scratch. Defaults to the temp dir, /tmp and /private/tmp. */
	tempRoots?: string[];
	/** Where quests' workspaces live. */
	workspaceRoot?: string;
	/** The home directory a bare `cd` or `~` means. */
	home?: string;
}

/** Classify a write target against the loaded quest and git signals. */
function classifyTarget(
	state: QuestState,
	absTarget: string,
	options: EnforceOptions,
): WriteClassification {
	const tempRoots = (options.tempRoots ?? defaultTempRoots()).map(canonical);
	return classifyWrite(canonical(absTarget), {
		questDir: state.questDir ? canonical(state.questDir) : null,
		scratchDir: state.scratchDir ? canonical(state.scratchDir) : null,
		tempRoots,
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
 * tree it accounts for. A write inside a tree the quest tracks is a
 * code home and flows. A write inside a git tree the quest does not
 * track is blocked with adoption guidance, so the quest comes to
 * account for every tree its code lives in; the remedy is one
 * satisfiable step (tree-adopt), never a dead end. A genuinely
 * homeless write -- outside every git tree, and not a device,
 * scratch or quest-internal -- is blocked with tree-add guidance.
 *
 * This is advisory and it fails open: if a write lands in a tracked
 * tree, or once the agent adopts the tree it is in, the block never
 * fires again.
 */
function trackedTreePaths(state: QuestState): string[] {
	if (!state.questDir) return [];
	const result = listTreesOnQuest(state.questDir);
	if (!result.ok) return [];
	// Compare on git roots: a tree belongs to exactly one root, so a
	// quest that adopted a subdirectory of a repo still matches a write
	// anywhere in that repo. Fall back to the raw path for a tracked
	// path that is not inside a git tree.
	return result.trees.map((t) => canonical(gitTreeRootOf(t.path) ?? t.path));
}

function enforceHome(
	state: QuestState,
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
	options: EnforceOptions,
): ToolCallEventResult | undefined {
	if (!state.questDir || !state.questId) return;
	if (state.documentKind !== "plan" || state.documentStage !== "build") return;
	const tracked = trackedTreePaths(state);
	const looseBlock = (): ToolCallEventResult => ({
		block: true,
		reason:
			"Quest workflow: this quest is in build, but this write lands outside every git working tree. Run `tree-add` to scaffold one (pass cwd to choose the repo, no need to change your session's directory), or write inside a git tree this quest works in. Do not unload the quest to bypass this.",
	});
	const adoptBlock = (root: string): ToolCallEventResult => ({
		block: true,
		reason: `Quest workflow: this write lands in ${root}, a git tree this quest does not track yet. Register it so the quest accounts for it: run the quest tree-adopt action with cwd set to a path inside ${root}. You do not need to change your session's directory; the cwd parameter is the adoption target. Adopted trees are tracked and never auto-pruned. Do not unload the quest to bypass this.`,
	});
	// A write inside a tracked tree flows; one inside an untracked git
	// tree gets adoption guidance; a homeless one gets tree-add.
	const verdict = (target: string): ToolCallEventResult | undefined => {
		const classification = classifyTarget(state, target, options);
		if (classification.category === "loose-file") return looseBlock();
		const root = classification.treeRoot;
		if (!root) return;
		if (tracked.some((p) => isWithin(root, p))) return;
		return adoptBlock(root);
	};
	for (const target of writeTargetsOf(toolName, input, cwd)) {
		const result = verdict(target);
		if (result) return result;
	}
	return;
}

/** Where quests' workspaces live unless a caller says otherwise. */
export function defaultWorkspaceRoot(): string {
	return cacheDir("quest-workspace");
}

/**
 * The writes and removals a tool call makes that the record can judge.
 * A bash target whose place the command does not say is left out: the
 * check on disk after the command finds whatever it did.
 */
export function recordWritesOf(
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
	home: string,
): RecordWrite[] {
	if (toolName === "write" || toolName === "edit") {
		const target = path.resolve(cwd, String(input.path ?? ""));
		return [
			{
				path: target,
				effect: "write",
				via: "tool",
				exists: existsSync(target),
			},
		];
	}
	if (toolName !== "bash") return [];
	const resolved = resolveBashWrites(String(input.command ?? ""), {
		cwd,
		home,
	});
	const of = (effect: RecordWrite["effect"]) => (target: string) => ({
		path: target,
		effect,
		via: "bash" as const,
		exists: existsSync(target),
	});
	return [
		...resolved.paths.map(of("write")),
		...resolved.removed.map(of("remove")),
	];
}

/**
 * The record's rules, which hold in every quest folder whatever is
 * loaded or focused: a write into a record is a record write whichever
 * session makes it.
 */
function enforceRecord(
	state: QuestState,
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
	options: EnforceOptions,
): ToolCallEventResult | undefined {
	const roots = {
		questsRoot: state.questsRoot,
		workspaceRoot: options.workspaceRoot ?? defaultWorkspaceRoot(),
	};
	for (const write of recordWritesOf(
		toolName,
		input,
		cwd,
		options.home ?? homedir(),
	)) {
		const refusal = judgeRecordWrite(write, roots);
		if (refusal) {
			return { block: true, reason: `Quest workflow: ${refusal.reason}` };
		}
	}
	return;
}

/** Check a tool call against the record and the focused document's discipline. */
export function enforceQuest(
	state: QuestState,
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
	options: EnforceOptions = {},
): ToolCallEventResult | undefined {
	const record = enforceRecord(state, toolName, input, cwd, options);
	if (record) return record;
	if (!isGateActive(state)) return;
	const funnel = systemTempFunnel(state, toolName, input, cwd, options);
	if (funnel) return funnel;
	if (isReadOnly(state))
		return enforcePhase(state, toolName, input, cwd, options);
	return enforceHome(state, toolName, input, cwd, options);
}

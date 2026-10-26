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
 * agent-facing reason, never a prompt. Each verdict names the guard
 * that gave it, and the caller asks the guard policy whether that
 * guard blocks: an untracked tree is adopted rather than refused by
 * default, so its verdict also carries the root to adopt.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import type { ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import {
	classifyBashWrite,
	resolveBashWrites,
} from "../../lib/core/internal/quest/bash-write.ts";
import {
	judgeRecordWrite,
	type RecordWrite,
} from "../../lib/core/internal/quest/record-gate.ts";
import { ensureQuestWorkspaceTmp } from "../../lib/core/internal/quest/workspace.ts";
import {
	classifyWrite,
	type WriteClassification,
} from "../../lib/core/internal/quest/write-classifier.ts";
import { GUARDS } from "../../lib/internal/guardian/guards.ts";
import {
	canonicalPath,
	gitTreeRootOf,
	isGitignored,
	isTracked,
	isWithin,
	trackedTreeRoot,
} from "../../lib/internal/quest/git-signals.ts";
import {
	applyEdits,
	ownedFieldChanges,
	type QuestFileKind,
} from "../../lib/internal/quest/owned-fields.ts";
import { listTreesOnQuest } from "../../lib/internal/quest/trees.ts";
import type { QuestState } from "./state.ts";
import { defaultWorkspaceRoot, workspaceDirOf } from "./workspace.ts";

/** A quest gate's verdict, naming the guard that gave it. */
export type QuestVerdict = ToolCallEventResult & {
	/** The guard whose mode decides whether this blocks. */
	guard: string;
	/** For a write into an untracked tree: the root to adopt instead. */
	adopt?: string;
	/**
	 * The paths outside every tree the call writes, noted for the quest
	 * when the guard lets the call through.
	 */
	outside?: string[];
};

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

/**
 * The destination paths a tool call writes to. Bash targets resolve
 * the way the shell would: `~` is the home directory and a `cd` moves
 * what a relative path means. A target whose place the command does
 * not say is left out, as the record gate leaves it out.
 */
function writeTargetsOf(
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
	options: EnforceOptions,
): string[] {
	if (toolName === "write" || toolName === "edit") {
		return [path.resolve(cwd, String(input.path ?? ""))];
	}
	if (toolName === "bash") {
		return resolveBashWrites(String(input.command ?? ""), {
			cwd,
			home: options.home ?? homedir(),
		}).paths;
	}
	return [];
}

/**
 * Funnel a write to bare system temp into the `tmp/` of the quest's
 * workspace. System temp is not reaped and leaks across runs, so
 * instead of allowing it the gate creates `tmp/` on first need and
 * names it as the place to redirect. Writes anywhere in the workspace
 * classify as quest scratch, not system temp, so they flow.
 */
function systemTempFunnel(
	state: QuestState,
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
	options: EnforceOptions,
): QuestVerdict | undefined {
	const root = options.workspaceRoot ?? defaultWorkspaceRoot();
	if (!state.questDir || !workspaceDirOf(root, state.questId)) return;
	const inTemp = writeTargetsOf(toolName, input, cwd, options).filter(
		(t) => classifyTarget(state, t, options).category === "system-temp",
	);
	if (inTemp.length === 0) return;
	const dir = ensureQuestWorkspaceTmp(root, state.questId ?? "");
	return {
		guard: GUARDS.questTemp.name,
		block: true,
		outside: inTemp,
		reason: `Quest workflow: this names a path in system temp, which nothing reaps. Use $TMPDIR instead (mktemp already does), which points at the tmp/ in this quest's scratch folder, cleared when the quest concludes: ${dir}`,
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
	// Every quest's workspace is scratch, never system temp and never
	// homeless in build: a workspace holds no record and no code home.
	// Not only the loaded quest's, since sessions leave notes in each
	// other's to coordinate, and 70 such writes were refused in a week.
	// A legacy scratch folder of the loaded quest's counts as well.
	const workspaces = options.workspaceRoot ?? defaultWorkspaceRoot();
	const legacy = state.scratchDir ? canonical(state.scratchDir) : null;
	const target = canonical(absTarget);
	const scratch =
		legacy && isWithin(target, legacy) ? legacy : canonical(workspaces);
	return classifyWrite(target, {
		questDir: state.questDir ? canonical(state.questDir) : null,
		scratchDir: scratch,
		tempRoots,
		isGitignored,
		isTracked,
		gitTreeRootOf,
	});
}

/**
 * Whether a plan in think or draft holds back changes to the tree at
 * `root`. The hold keeps this plan's implementation waiting for its
 * plan, so it covers the trees the quest works in. A fix to some other
 * repository is not this plan's implementation, and refusing it only
 * sent the agent to unfocus and retry. A quest that tracks no tree yet
 * has not said where its code lives, so every tree is held.
 */
function holdsTree(state: QuestState, root: string | undefined): boolean {
	const tracked = trackedTreePaths(state);
	if (tracked.length === 0) return true;
	return root !== undefined && tracked.some((p) => isWithin(root, p));
}

/**
 * The plan-phase write gate: in think or draft, defer only edits to
 * already-tracked code in a tree the plan holds. The plan document,
 * quest-internal files, scratch and brand-new (untracked) files all
 * flow, so drafting and scratch exploration are never cornered.
 */
function enforcePhase(
	state: QuestState,
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
	options: EnforceOptions,
): QuestVerdict | undefined {
	if (toolName === "write" || toolName === "edit") {
		if (isFocusedDocWrite(toolName, input, state.documentPath, cwd)) return;
		const target = path.resolve(cwd, String(input.path ?? ""));
		const classification = classifyTarget(state, target, options);
		if (
			classification.category === "tracked-code" &&
			holdsTree(state, classification.treeRoot)
		) {
			return {
				guard: GUARDS.questPlanStage.name,
				block: true,
				reason: `Quest workflow (plan ${state.documentStage}): this edits already-tracked code. Move to build to implement, or keep planning notes in the plan, the quest's attachments/ or its scratch folder.`,
			};
		}
		return;
	}

	if (toolName === "bash") {
		const command = String(input.command ?? "");
		const kind = classifyBashWrite(command);
		if (
			kind === "git-mutating" &&
			holdsTree(state, gitTreeRootOf(cwd) ?? undefined)
		) {
			return {
				guard: GUARDS.questPlanStage.name,
				block: true,
				reason: `Quest workflow (plan ${state.documentStage}): git-mutating command blocked. Move to build first.`,
			};
		}
		if (kind === "bash-write") {
			const lands = writeTargetsOf(toolName, input, cwd, options)
				.map((t) => classifyTarget(state, t, options))
				.some(
					(c) => c.category === "tracked-code" && holdsTree(state, c.treeRoot),
				);
			if (lands) {
				return {
					guard: GUARDS.questPlanStage.name,
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
 * track names that tree for adoption, so the quest comes to account
 * for every tree its code lives in: by default the caller adopts it,
 * and in block mode the agent is told to. A write into any quest's
 * record is the record gate's business, not this one's. A genuinely
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
	return result.trees.map((t) => trackedTreeRoot(t.path));
}

function enforceHome(
	state: QuestState,
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
	options: EnforceOptions,
): QuestVerdict | undefined {
	if (!state.questDir || !state.questId) return;
	if (state.documentKind !== "plan" || state.documentStage !== "build") return;
	const tracked = trackedTreePaths(state);
	const looseBlock = (outside: string[]): QuestVerdict => ({
		guard: GUARDS.questHomeless.name,
		block: true,
		outside,
		reason:
			"Quest workflow: this quest is in build, but this write lands outside every git tree. Run `tree-add` to cut one (pass cwd to choose the repo, no need to change your session's directory), or write inside a git tree this quest works in. A write that belongs outside every tree (live machine config, a shared file) is noted for the quest when it goes ahead, and conclude names it. Do not unload the quest to bypass this.",
	});
	const adoptBlock = (root: string): QuestVerdict => ({
		guard: GUARDS.questUntrackedTree.name,
		adopt: root,
		block: true,
		reason: `Quest workflow: this write lands in ${root}, a git tree this quest does not track yet. Register it so the quest accounts for it: run the quest tree-adopt action with cwd set to a path inside ${root}. You do not need to change your session's directory; the cwd parameter is the adoption target. Adopted trees are tracked and never auto-pruned. Do not unload the quest to bypass this.`,
	});
	// A write inside a tracked tree flows; one inside an untracked git
	// tree gets adoption guidance; a homeless one gets tree-add, and
	// every homeless target is named so it can be noted.
	const loose: string[] = [];
	const verdict = (target: string): QuestVerdict | undefined => {
		// Every quest's folder holds its record, whichever quest is loaded,
		// and the record gate has already judged the write.
		if (isWithin(target, state.questsRoot)) return;
		const classification = classifyTarget(state, target, options);
		if (classification.category === "loose-file") {
			loose.push(target);
			return;
		}
		const root = classification.treeRoot;
		if (!root) return;
		if (tracked.some((p) => isWithin(root, p))) return;
		return adoptBlock(root);
	};
	for (const target of writeTargetsOf(toolName, input, cwd, options)) {
		const result = verdict(target);
		if (result) return result;
	}
	return loose.length > 0 ? looseBlock(loose) : undefined;
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
): QuestVerdict | undefined {
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
			return {
				guard: GUARDS.questRecord.name,
				block: true,
				reason: `Quest workflow: ${refusal.reason}`,
			};
		}
	}
	return;
}

/** The folders documents live in, under a quest's directory. */
const DOCUMENT_DIRS: ReadonlySet<string> = new Set([
	"plans",
	"research",
	"briefs",
	"reports",
]);

/** Whether a path is a quest's README or one of its documents. */
function questFileKind(
	questsRoot: string,
	file: string,
): QuestFileKind | undefined {
	const rel = path.relative(canonicalPath(questsRoot), canonicalPath(file));
	if (rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
	const parts = rel.split(path.sep);
	if (parts.length === 2 && parts[1] === "README.md") return "readme";
	if (
		parts.length === 3 &&
		DOCUMENT_DIRS.has(parts[1]) &&
		parts[2].endsWith(".md")
	) {
		return "document";
	}
	return undefined;
}

/** A write or edit's path, with `~` read as the home directory. */
function toolPath(
	input: Record<string, unknown>,
	cwd: string,
	home: string,
): string {
	const raw = String(input.path ?? "");
	const expanded =
		raw === "~" || raw.startsWith("~/") ? path.join(home, raw.slice(1)) : raw;
	return path.resolve(cwd, expanded);
}

/** The replacements an edit call carries, in either of its shapes. */
function editsOf(
	input: Record<string, unknown>,
): { oldText: string; newText: string }[] {
	const listed = Array.isArray(input.edits) ? input.edits : [input];
	return listed.flatMap((edit: unknown) => {
		if (typeof edit !== "object" || edit === null) return [];
		const { oldText, newText } = edit as Record<string, unknown>;
		return typeof oldText === "string" && typeof newText === "string"
			? [{ oldText, newText }]
			: [];
	});
}

/**
 * Refuse a write or edit that changes a field the workflow owns, such
 * as a document's stage or a quest's status, and name the verb that
 * changes it. Everything else in the file flows.
 */
function enforceOwnedFields(
	state: QuestState,
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
	options: EnforceOptions,
): QuestVerdict | undefined {
	if (toolName !== "write" && toolName !== "edit") return;
	const file = toolPath(input, cwd, options.home ?? homedir());
	const kind = questFileKind(state.questsRoot, file);
	if (!kind || !existsSync(file)) return;
	let before: string;
	try {
		before = readFileSync(file, "utf8");
	} catch {
		// Unreadable here means unreadable to the tool too, which says so.
		return;
	}
	// A write with no content is malformed, and the tool refuses it itself.
	const after =
		toolName === "write"
			? typeof input.content === "string"
				? input.content
				: undefined
			: applyEdits(before, editsOf(input));
	if (after === undefined) return;
	const changes = ownedFieldChanges(kind, before, after);
	if (changes.length === 0) return;
	const named = changes
		.map(
			(c) =>
				`\`${c.field}\` (${c.from ?? "absent"} to ${c.to ?? "absent"}) is changed by ${c.verb}`,
		)
		.join("; ");
	return {
		guard: GUARDS.questOwnedFields.name,
		block: true,
		reason: `Quest workflow: ${named}. Leave the front matter as it is and use the quest tool for that; the rest of the file is yours to edit.`,
	};
}

/**
 * Every gate's verdict on a tool call, in the order the gates run: the
 * record, then system temp, then the plan stage or the build home. The
 * caller applies each guard's mode, so a gate that is off or relents
 * does not hide the ones after it.
 */
export function questVerdicts(
	state: QuestState,
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
	options: EnforceOptions = {},
): QuestVerdict[] {
	const verdicts = [
		enforceRecord(state, toolName, input, cwd, options),
		enforceOwnedFields(state, toolName, input, cwd, options),
	];
	if (isGateActive(state)) {
		verdicts.push(systemTempFunnel(state, toolName, input, cwd, options));
		verdicts.push(
			isReadOnly(state)
				? enforcePhase(state, toolName, input, cwd, options)
				: enforceHome(state, toolName, input, cwd, options),
		);
	}
	return verdicts.filter((v): v is QuestVerdict => v !== undefined);
}

/** The first gate's verdict on a tool call, as if every guard blocked. */
export function enforceQuest(
	state: QuestState,
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
	options: EnforceOptions = {},
): QuestVerdict | undefined {
	return questVerdicts(state, toolName, input, cwd, options)[0];
}

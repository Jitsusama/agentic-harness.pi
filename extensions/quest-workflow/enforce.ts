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

import { existsSync, readFileSync, realpathSync } from "node:fs";
import * as path from "node:path";
import type { ToolCallEventResult } from "@mariozechner/pi-coding-agent";
import { listTreesOnQuest } from "../../lib/internal/quest/trees.js";
import { parseQuestFrontMatter } from "../../lib/quest/index.js";
import { BASH_WRITE_PATTERNS, GIT_MUTATING, type QuestState } from "./state.js";

function looksLikeBashWrite(command: string): boolean {
	return BASH_WRITE_PATTERNS.some((rx) => rx.test(command));
}

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
 * Whether the write target lives anywhere under the loaded
 * quest's own directory. Such writes are always considered
 * "on the quest itself" and don't trigger the no-tree
 * guardian. The previous version only matched README.md
 * plus four named subdirs, so a write to
 * `<questDir>/notes.md` or to any human-added folder
 * (`<questDir>/runs/`, `<questDir>/workloads/`) was
 * misclassified as an external code write.
 */
function isQuestInternalWrite(
	input: Record<string, unknown>,
	questDir: string | null,
	cwd: string,
): boolean {
	if (!questDir) return false;
	const resolved = path.resolve(cwd, String(input.path ?? ""));
	const questResolved = path.resolve(questDir);
	return (
		resolved === questResolved ||
		resolved.startsWith(`${questResolved}${path.sep}`)
	);
}

/** Whether a directory sits inside a git working tree. */
function isInsideGitWorkTree(dir: string): boolean {
	let current = path.resolve(dir);
	while (true) {
		if (existsSync(path.join(current, ".git"))) return true;
		const parent = path.dirname(current);
		if (parent === current) return false;
		current = parent;
	}
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
		return p;
	}
}

/**
 * Resolve the active-code directories from the quest's recorded
 * sessions: the cwd of an active session that still exists on
 * disk and sits inside a git working tree. Only sessions still
 * marked active count, so a long-dead or cleanly-detached load
 * from an incidental directory does not stand the gate down
 * forever. Paths are canonicalized so a /var versus /private/var
 * spelling does not defeat the later prefix check.
 */
function sessionCodeDirs(questDir: string): string[] {
	let text: string;
	try {
		text = readFileSync(path.join(questDir, "README.md"), "utf8");
	} catch {
		// README missing or unreadable; no code dir resolves.
		return [];
	}
	const parsed = parseQuestFrontMatter(text);
	if (!parsed) return [];
	const dirs: string[] = [];
	for (const session of parsed.frontMatter.sessions) {
		if (session.status !== "active") continue;
		const cwd = session.cwd;
		if (cwd && existsSync(cwd) && isInsideGitWorkTree(cwd)) {
			dirs.push(canonical(cwd));
		}
	}
	return dirs;
}

/**
 * Reactive guardian: when the loaded quest is code-bearing
 * (has a focused build-stage plan) but no working tree, block
 * writes to anything outside the quest's own directory.
 *
 * The gate stands down the moment an active-code directory is
 * known: a registered tree, or a recorded session's git
 * working directory. This is R14 -- editing inside a known
 * working tree during build never requires unloading the
 * quest; the gate fires only when no code home resolves,
 * pushing the agent toward `tree-add` rather than `unload`.
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
	const codeDirs = sessionCodeDirs(state.questDir);
	if (codeDirs.length > 0) {
		const resolved = canonical(
			path.resolve(canonical(cwd), String(input.path ?? "")),
		);
		if (
			codeDirs.some(
				(dir) => resolved === dir || resolved.startsWith(`${dir}${path.sep}`),
			)
		) {
			return;
		}
	}
	return {
		block: true,
		reason:
			"Quest workflow: this quest is in build with no working tree. Run `tree-add` to scaffold one, or work inside a tree this quest already owns. Do not unload the quest to bypass this.",
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

		if (toolName === "bash") {
			const command = String(input.command ?? "");
			if (GIT_MUTATING.test(command)) {
				return {
					block: true,
					reason: `Quest workflow (plan ${state.documentStage}): git-mutating command blocked. Move to build first.`,
				};
			}
			if (looksLikeBashWrite(command)) {
				return {
					block: true,
					reason: `Quest workflow (plan ${state.documentStage}): bash write pattern blocked (sed -i, cat >, tee, etc.). Use the write/edit tools, or move to build first. This is agent discipline, not a sandbox: pass the work through the right phase.`,
				};
			}
		}
	}

	return enforceNoTree(state, toolName, input, cwd);
}

/**
 * Lifecycle operations for the quest workflow: load,
 * unload, focus, unfocus, restore on session start, persist
 * back to disk. The state object owns the projections; this
 * module bridges between disk artifacts and that state.
 */

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
} from "node:fs";
import { join, sep } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolContext,
} from "@mariozechner/pi-coding-agent";
import { sessionsDir } from "../../lib/internal/paths.js";
import {
	type AliasIndex,
	buildAliasIndex,
} from "../../lib/internal/quest/alias-index.js";
import { appendJourneyByPath } from "../../lib/internal/quest/append-journey.js";
import { nowYmd } from "../../lib/internal/quest/dates.js";
import {
	discoverQuests,
	type QuestEntry,
	siblingRanks,
} from "../../lib/internal/quest/discovery.js";
import {
	atomicWriteFile,
	atomicWriteUnderLock,
} from "../../lib/internal/quest/io.js";
import { mutateQuestFrontMatter } from "../../lib/internal/quest/mutate.js";
import {
	diffRanks,
	nextRank,
	type RankEntry,
	after as rankAfter,
	before as rankBefore,
	bottom as rankBottom,
	bump as rankBump,
	renumber as rankRenumber,
	sink as rankSink,
	top as rankTop,
} from "../../lib/internal/quest/ranking.js";
import {
	indexSessionFiles,
	prunePhantomSessions,
} from "../../lib/internal/quest/session-liveness.js";
import { isSealedStatus } from "../../lib/internal/quest/status.js";
import { getLastEntry } from "../../lib/internal/state.js";
import {
	checkboxProgress,
	type DocumentFrontMatter,
	type DocumentKind,
	type DocumentStage,
	parseDocumentFrontMatter,
	parseQuestDoc,
	type QuestAlias,
	type QuestFrontMatter,
	type QuestPriority,
	type QuestSession,
	type QuestStatus,
	serializeDocumentFrontMatter,
} from "../../lib/quest/index.js";
import type { Stage } from "./machine.js";
import { sessionNameFor } from "./render.js";
import type { QuestState } from "./state.js";

/**
 * Persist the focused document's progress (or, when no
 * document is focused, the loaded quest's) into the
 * QuestState struct so the widget can paint without
 * re-parsing the body on every keystroke.
 *
 * Uses the broad `checkboxProgress` walk so every `- [ ]`
 * / `- [x]` in the body contributes regardless of which
 * section holds it. The plan, research, brief and report
 * templates each use a different section name for their
 * work list; one counter serves them all.
 */
export function refreshProgress(state: QuestState): void {
	if (state.documentPath) {
		try {
			const text = readFileSync(state.documentPath, "utf8");
			const parsed = parseDocumentFrontMatter(text);
			if (parsed) {
				const progress = checkboxProgress(parsed.body);
				state.done = progress.done;
				state.total = progress.total;
				state.currentItem = progress.currentItem;
				state.documentStage = parsed.frontMatter.stage as Stage;
				return;
			}
		} catch {
			// Document missing or unreadable; fall through.
		}
	}
	if (state.questDir) {
		try {
			const text = readFileSync(join(state.questDir, "README.md"), "utf8");
			const parsed = parseQuestDoc(text);
			if (parsed) {
				const progress = checkboxProgress(parsed.body);
				state.done = progress.done;
				state.total = progress.total;
				state.currentItem = progress.currentItem;
				return;
			}
		} catch {
			// Quest missing; fall through.
		}
	}
	state.done = 0;
	state.total = 0;
	state.currentItem = undefined;
}

/** Find a quest entry by id across the quests root. */
export function findQuestEntry(
	state: QuestState,
	id: string,
): QuestEntry | undefined {
	const { index } = discoverQuests(state.questsRoot);
	return index.quests.get(id);
}

/** Load a quest into state by id. */
export function loadQuest(
	state: QuestState,
	pi: ExtensionAPI,
	id: string,
): { ok: true } | { ok: false; guidance: string } {
	const entry = findQuestEntry(state, id);
	if (!entry) {
		return {
			ok: false,
			guidance: `No quest with id "${id}" under ${state.questsRoot}.`,
		};
	}
	state.questDir = entry.dir;
	state.questId = entry.doc.frontMatter.id;
	state.questTitle = entry.doc.title ?? null;
	state.questKind = entry.doc.frontMatter.kind;
	state.questStatus = entry.doc.frontMatter.status;
	state.questPriority = entry.doc.frontMatter.priority;
	state.scratchDir = entry.doc.frontMatter.scratchDir ?? null;
	state.documentPath = null;
	state.documentId = null;
	state.documentKind = null;
	state.documentTitle = null;
	state.documentStage = "idle";
	refreshProgress(state);
	const sessionName = sessionNameFor(entry.doc.title ?? null);
	if (sessionName) pi.setSessionName?.(sessionName);
	return { ok: true };
}

/**
 * Re-read the loaded quest's README and refresh the in-memory
 * slice (title, kind, status, priority) so an edit to the quest's
 * own README shows up in the status line without a manual reload.
 * No-op when no quest is loaded or the README cannot be read.
 */
export function refreshLoadedSlice(state: QuestState): void {
	if (!state.questDir) return;
	let text: string;
	try {
		text = readFileSync(join(state.questDir, "README.md"), "utf8");
	} catch {
		// README missing or unreadable; leave the slice as-is.
		return;
	}
	const parsed = parseQuestDoc(text);
	if (!parsed) return;
	state.questTitle = parsed.title ?? null;
	state.questKind = parsed.frontMatter.kind;
	state.questStatus = parsed.frontMatter.status;
	state.questPriority = parsed.frontMatter.priority;
	state.scratchDir = parsed.frontMatter.scratchDir ?? null;
}

/** Unload the currently loaded quest. */
export function unloadQuest(state: QuestState): void {
	state.questDir = null;
	state.questId = null;
	state.questTitle = null;
	state.questKind = null;
	state.questStatus = null;
	state.questPriority = null;
	state.scratchDir = null;
	state.documentPath = null;
	state.documentId = null;
	state.documentKind = null;
	state.documentTitle = null;
	state.documentStage = "idle";
	state.done = 0;
	state.total = 0;
}

/** Focus a document under the loaded quest. */
export function focusDocument(
	state: QuestState,
	docPath: string,
): { ok: true } | { ok: false; guidance: string } {
	if (!state.questDir) {
		return { ok: false, guidance: "Load a quest first." };
	}
	let text: string;
	try {
		text = readFileSync(docPath, "utf8");
	} catch (err) {
		return {
			ok: false,
			guidance: `Cannot read ${docPath}: ${(err as Error).message}`,
		};
	}
	const parsed = parseDocumentFrontMatter(text);
	if (!parsed) {
		return {
			ok: false,
			guidance: `Document ${docPath} has no valid front-matter.`,
		};
	}
	state.documentPath = docPath;
	state.documentId = parsed.frontMatter.id;
	state.documentKind = parsed.frontMatter.kind;
	state.documentTitle = extractTitle(parsed.body);
	state.documentStage = parsed.frontMatter.stage as Stage;
	refreshProgress(state);
	return { ok: true };
}

/** Unfocus the active document. */
export function unfocusDocument(state: QuestState): void {
	state.documentPath = null;
	state.documentId = null;
	state.documentKind = null;
	state.documentTitle = null;
	state.documentStage = "idle";
	refreshProgress(state);
}

/**
 * Persist the focused document's stage back to disk.
 *
 * Mutates the in-memory `state.documentStage` only after
 * the write returns, so a failed write does not diverge
 * memory from disk.
 */
/**
 * Persist the focused document's stage to its file and mirror it in
 * state. Returns true when the stage reached disk, false when there
 * is nothing to write to or the file is unreadable or unparseable,
 * so the caller can refuse rather than let memory run ahead of disk.
 */
export function writeDocumentStage(state: QuestState, stage: Stage): boolean {
	if (!state.documentPath) return false;
	const questDir = state.questDir;
	let text: string;
	try {
		text = readFileSync(state.documentPath, "utf8");
	} catch {
		return false;
	}
	const parsed = parseDocumentFrontMatter(text);
	if (!parsed) return false;
	const newFm: DocumentFrontMatter = {
		...parsed.frontMatter,
		stage: stage as DocumentStage,
		updated: nowYmd(),
	};
	const newText = `${serializeDocumentFrontMatter(newFm)}\n${parsed.body}`;
	const documentPath = state.documentPath;
	if (questDir) {
		atomicWriteUnderLock(questDir, documentPath, newText);
	} else {
		atomicWriteFile(documentPath, newText);
	}
	state.documentStage = stage;
	return true;
}

const DOC_KIND_DIRS = ["plans", "research", "briefs", "reports"];
const ACTIVE_DOC_STAGES = new Set(["think", "draft", "build"]);

/**
 * Seal every still-active document under a quest to the quest's
 * terminal stage, so concluding or retiring a quest does not leave
 * documents stranded mid-stage. Returns how many were sealed.
 * Best-effort per file: an unreadable document is skipped, not fatal.
 */
export function sealQuestDocuments(
	questDir: string,
	target: "concluded" | "retired",
): number {
	let sealed = 0;
	for (const kindDir of DOC_KIND_DIRS) {
		const dir = join(questDir, kindDir);
		let entries: ReturnType<typeof readdirSync>;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
			const docPath = join(dir, entry.name);
			let text: string;
			try {
				text = readFileSync(docPath, "utf8");
			} catch {
				continue;
			}
			const parsed = parseDocumentFrontMatter(text);
			if (!parsed) continue;
			if (!ACTIVE_DOC_STAGES.has(parsed.frontMatter.stage)) continue;
			const newFm: DocumentFrontMatter = {
				...parsed.frontMatter,
				stage: target,
				updated: nowYmd(),
			};
			atomicWriteUnderLock(
				questDir,
				docPath,
				`${serializeDocumentFrontMatter(newFm)}\n${parsed.body}`,
			);
			sealed++;
		}
	}
	return sealed;
}

/** Append a Journey entry to the loaded quest's README. */
export function appendJourneyEntry(state: QuestState, prose: string): void {
	if (!state.questDir) return;
	const ok = appendJourneyByPath(state.questDir, prose);
	if (!ok) {
		console.warn(
			`[quest-workflow] failed to append Journey entry to ${state.questDir}; README missing or unreadable.`,
		);
		return;
	}
	stampQuestUpdated(state);
}

/** Update the loaded quest's `updated` frontmatter to today. */
export function stampQuestUpdated(state: QuestState): void {
	if (!state.questDir) return;
	// The identity transform still stamps updated in the core, so a
	// touch is validated and locked like every other quest write.
	mutateQuestFrontMatter(state.questDir, (fm) => fm);
}

/**
 * Canonicalize a path for prefix comparison: resolve
 * symlinks and normalize `/var` vs `/private/var` on macOS
 * via realpath, which also yields the on-disk casing on a
 * case-insensitive filesystem. Returns the input on failure
 * so a missing path still compares against something stable.
 */
function canonicalForCompare(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

function isUnder(child: string, parent: string): boolean {
	if (child === parent) return true;
	return child.startsWith(`${parent}${sep}`);
}

/**
 * Customtype tag used to persist the loaded quest and
 * focused document into the session history. The pi
 * session entries are the durable store; `restore` reads
 * the most recent entry on session_start and re-hydrates
 * the in-memory state from it. Same channel pr-workflow
 * uses for its roster, judge config and last run state.
 */
const SESSION_KEY = "quest-workflow";

/** Snapshot persisted across reloads. */
interface PersistedState {
	/** The id of the loaded quest, when one is loaded. */
	questId: string | null;
	/**
	 * The absolute on-disk path of the focused document
	 * under the loaded quest. The path is the stable
	 * identifier inside the quest dir; the kind, stage and
	 * title get re-derived from the document's own
	 * frontmatter when restoring.
	 */
	documentPath: string | null;
	/**
	 * The session's working directory at persist time, so a
	 * resumed session has the cwd without re-deriving it from
	 * the tree or session store.
	 */
	cwd: string | null;
}

function snapshot(state: QuestState, cwd: string | null): PersistedState {
	return {
		questId: state.questId,
		documentPath: state.documentPath,
		cwd,
	};
}

/**
 * Persist the current loaded-quest and focused-document
 * pointers into the session history.
 *
 * Skips the append when the snapshot equals the most
 * recent persisted entry. The tool_result hook fires on
 * every tool, so a long session that never touches the
 * quest tool used to accumulate dozens of identical
 * entries; the restore path only reads the latest one, so
 * everything past the first was dead weight. The skip
 * preserves restore semantics because `restore` still
 * reads the same data — it just doesn't have a fresh
 * copy of it on every keystroke.
 *
 * Dedup uses an in-memory key on QuestState (O(1)) when
 * one is set, falling back to a one-time `getLastEntry`
 * disk read when the cache is empty (fresh session). The
 * cache stays write-only inside `persist`: once we've
 * appended, we update it; every subsequent call within
 * the session compares against it without touching disk.
 *
 * Wired centrally from the tool_result hook in the
 * extension entry point, mirroring the pr-workflow
 * pattern.
 */
export function persist(
	state: QuestState,
	pi: ExtensionAPI,
	ctx?: ExtensionContext,
): void {
	const current = snapshot(state, ctx?.cwd ?? null);
	const key = snapshotKey(current);
	if (state.lastPersistedKey === key) return;
	if (state.lastPersistedKey === undefined && ctx) {
		const prev = getLastEntry<PersistedState>(ctx, SESSION_KEY);
		if (prev && snapshotsEqual(prev, current)) {
			state.lastPersistedKey = key;
			return;
		}
	}
	pi.appendEntry(SESSION_KEY, current);
	state.lastPersistedKey = key;
}

function snapshotKey(s: PersistedState): string {
	return `${s.questId ?? ""}|${s.documentPath ?? ""}|${s.cwd ?? ""}`;
}

/**
 * Structural equality on persisted snapshots. Compares
 * by the full set of `PersistedState` keys so adding a
 * field later doesn't silently break the dedup behaviour.
 */
function snapshotsEqual(a: PersistedState, b: PersistedState): boolean {
	const aKeys = Object.keys(a) as (keyof PersistedState)[];
	const bKeys = Object.keys(b) as (keyof PersistedState)[];
	if (aKeys.length !== bKeys.length) return false;
	for (const key of aKeys) {
		if (a[key] !== b[key]) return false;
	}
	return true;
}

/**
 * Restore the persisted slice on session_start. Returns
 * true when something was hydrated, false when no entry
 * was recorded or the quest no longer exists on disk so
 * the caller can fall through to its other restore paths
 * (the spawn autoload-env hint, then the cwd walk).
 */
export function restore(
	state: QuestState,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): boolean {
	const saved = getLastEntry<PersistedState>(ctx, SESSION_KEY);
	if (!saved || !saved.questId) return false;
	const result = loadQuest(state, pi, saved.questId);
	if (!result.ok) return false;
	if (saved.documentPath) {
		// The quest is loaded; try to restore the focused
		// document. A missing or unparsable document is not
		// fatal: the quest stays loaded and the user re-focuses
		// if they care to.
		focusDocument(state, saved.documentPath);
	}
	return true;
}

/** How the startup resolver chose the quest to load. */
export interface StartupResolution {
	source: "explicit" | "persisted" | "cwd" | "none";
	questId: string | null;
}

/**
 * The one startup resolution pipeline, with an explicit precedence:
 *
 * 1. An explicit request wins. A spawn ships the target quest id in
 *    an env var, and that intent must beat this session's persisted
 *    history, so a spawned tab that resumes a session lands on the
 *    quest it was opened for rather than the one that session last
 *    held.
 * 2. Persisted session history next. A /reload reuses the same
 *    session, so the last loaded quest and focused document are
 *    exactly the right thing to restore.
 * 3. The cwd last. A fresh session with no history resolves from the
 *    quest directory or working tree it launched inside.
 *
 * Consumes and clears the env var so the hint never carries across an
 * in-process session restart.
 */
export function resolveStartup(
	state: QuestState,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): StartupResolution {
	const autoloadId = process.env.QUEST_WORKFLOW_AUTOLOAD_ID;
	if (autoloadId) {
		delete process.env.QUEST_WORKFLOW_AUTOLOAD_ID;
		if (loadQuest(state, pi, autoloadId).ok) {
			return { source: "explicit", questId: state.questId };
		}
	}
	if (restore(state, pi, ctx)) {
		return { source: "persisted", questId: state.questId };
	}
	restoreFromCwd(state, pi, ctx);
	return {
		source: state.questId ? "cwd" : "none",
		questId: state.questId,
	};
}

/** Restore on session_start by re-reading from disk if a quest dir was remembered. */
export function restoreFromCwd(
	state: QuestState,
	pi: ExtensionAPI,
	ctx: ToolContext,
): void {
	const rawCwd = ctx.cwd;
	if (!rawCwd) return;
	const cwd = canonicalForCompare(rawCwd);
	const { index } = discoverQuests(state.questsRoot);
	// 1. Quest directory match: the session's cwd is
	//    inside a quest's own folder. Prefer a live quest
	//    over a sealed one when both directories cover the
	//    cwd, so a fresh pi launched inside a concluded
	//    quest's tree does not auto-load the concluded
	//    quest, matching the explicit load verb's resolver.
	let dirMatch: string | undefined;
	let dirMatchLive = false;
	for (const entry of index.quests.values()) {
		if (!isUnder(cwd, canonicalForCompare(entry.dir))) continue;
		const live = !isSealedStatus(entry.doc.frontMatter.status);
		if (dirMatch === undefined || (live && !dirMatchLive)) {
			dirMatch = entry.doc.frontMatter.id;
			dirMatchLive = live;
		}
	}
	if (dirMatch !== undefined) {
		loadQuest(state, pi, dirMatch);
		return;
	}
	// 2. Tree-alias match: the cwd is inside a working
	//    tree registered on some quest. Walk every quest's
	//    `git-worktree:` aliases (path values) and the
	//    quest's `trees:` array; pick the deepest match so
	//    nested trees resolve to the innermost owner, with a
	//    live quest breaking a tie against a sealed one. Each
	//    candidate path is canonicalized so /var and
	//    /private/var (and bind-mounts in containers) match.
	let bestQuestId: string | undefined;
	let bestMatchLen = -1;
	let bestLive = false;
	const consider = (questId: string, treePath: string, live: boolean) => {
		const real = canonicalForCompare(treePath);
		if (!isUnder(cwd, real)) return;
		if (
			real.length > bestMatchLen ||
			(real.length === bestMatchLen && live && !bestLive)
		) {
			bestMatchLen = real.length;
			bestQuestId = questId;
			bestLive = live;
		}
	};
	for (const entry of index.quests.values()) {
		const fm = entry.doc.frontMatter;
		const live = !isSealedStatus(fm.status);
		for (const a of fm.aliases) {
			if (a.type === "git-worktree") consider(fm.id, a.value, live);
		}
		for (const tree of fm.trees ?? []) consider(fm.id, tree.path, live);
	}
	if (bestQuestId) loadQuest(state, pi, bestQuestId);
}

function extractTitle(body: string): string | null {
	const match = /^#\s+(.+)$/m.exec(body);
	return match ? match[1].trim() : null;
}

/** Create a new document under the loaded quest. */
export function createDocument(
	state: QuestState,
	opts: {
		id: string;
		kind: DocumentKind;
		title: string;
		stage: Stage;
		scaffoldBody: string;
	},
): string | undefined {
	if (!state.questDir) return undefined;
	const subDir: Record<DocumentKind, string> = {
		plan: "plans",
		research: "research",
		brief: "briefs",
		report: "reports",
	};
	const dir = join(state.questDir, subDir[opts.kind]);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${opts.id}.md`);
	// New document; scaffold atomically. Subsequent writes go
	// through writeDocumentStage which holds the lock too.
	atomicWriteUnderLock(state.questDir, path, opts.scaffoldBody);
	return path;
}

/** One working tree in the cross-quest inventory. */
export interface WorktreeInventoryEntry {
	path: string;
	branch?: string;
	questId: string;
	questTitle: string | null;
	/** Whether the tree's directory still exists on disk. */
	exists: boolean;
}

/**
 * Inventory every working tree recorded across all quests,
 * attributing each to its owning quest. This is what lets the
 * harness-created trees be seen and reaped in one place instead
 * of being a mystery pile of directories.
 */
export function inventoryWorktrees(
	state: QuestState,
): WorktreeInventoryEntry[] {
	const { index } = discoverQuests(state.questsRoot);
	const entries: WorktreeInventoryEntry[] = [];
	for (const quest of index.quests.values()) {
		const fm = quest.doc.frontMatter;
		for (const tree of fm.trees ?? []) {
			const entry: WorktreeInventoryEntry = {
				path: tree.path,
				questId: fm.id,
				questTitle: quest.doc.title ?? null,
				exists: existsSync(tree.path),
			};
			if (tree.branch) entry.branch = tree.branch;
			entries.push(entry);
		}
	}
	return entries.sort((a, b) => a.path.localeCompare(b.path));
}

/** Discover quests for /quest-list etc. */
export function listAllQuests(state: QuestState): QuestEntry[] {
	const { index } = discoverQuests(state.questsRoot);
	return [...index.quests.values()];
}

/** Ensure the quests root exists on disk. */
export function ensureQuestsRoot(state: QuestState): void {
	if (!existsSync(state.questsRoot)) {
		mkdirSync(state.questsRoot, { recursive: true });
	}
}

export type RankAction =
	| { kind: "top" }
	| { kind: "bottom" }
	| { kind: "bump" }
	| { kind: "sink" }
	| { kind: "before"; target: string }
	| { kind: "after"; target: string }
	| { kind: "renumber" };

export interface ReorderResult {
	siblings: QuestEntry[];
	changes: { id: string; from: number; to: number }[];
}

/**
 * Reorder the sibling set the given quest belongs to.
 * Siblings share both `parent` and `priority`. Writes the
 * updated rank back to every quest whose rank changed.
 */
export function reorderSiblings(
	state: QuestState,
	questId: string,
	action: RankAction,
): { ok: true; result: ReorderResult } | { ok: false; guidance: string } {
	const { index } = discoverQuests(state.questsRoot);
	const pivot = index.quests.get(questId);
	if (!pivot) {
		return {
			ok: false,
			guidance: `No quest with id "${questId}" under ${state.questsRoot}.`,
		};
	}
	if (isSealedStatus(pivot.doc.frontMatter.status)) {
		return {
			ok: false,
			guidance: `Quest "${questId}" is ${pivot.doc.frontMatter.status}; reopen it before reordering.`,
		};
	}
	const siblings: QuestEntry[] = [];
	for (const entry of index.quests.values()) {
		if (
			entry.doc.frontMatter.parent === pivot.doc.frontMatter.parent &&
			entry.doc.frontMatter.priority === pivot.doc.frontMatter.priority &&
			!isSealedStatus(entry.doc.frontMatter.status)
		) {
			siblings.push(entry);
		}
	}
	const before: RankEntry[] = siblings.map((e) => ({
		id: e.doc.frontMatter.id,
		rank: e.doc.frontMatter.rank,
	}));
	let after: RankEntry[];
	switch (action.kind) {
		case "top":
			after = rankTop(before, questId);
			break;
		case "bottom":
			after = rankBottom(before, questId);
			break;
		case "bump":
			after = rankBump(before, questId);
			break;
		case "sink":
			after = rankSink(before, questId);
			break;
		case "before":
			after = rankBefore(before, questId, action.target);
			break;
		case "after":
			after = rankAfter(before, questId, action.target);
			break;
		case "renumber":
			after = rankRenumber(before);
			break;
	}
	const changes = diffRanks(before, after);
	const rankById = new Map(after.map((e) => [e.id, e.rank]));
	for (const entry of siblings) {
		const newRank = rankById.get(entry.doc.frontMatter.id);
		if (newRank === undefined) continue;
		if (newRank === entry.doc.frontMatter.rank) continue;
		writeQuestRank(entry.dir, newRank);
	}
	return { ok: true, result: { siblings, changes } };
}

function writeQuestRank(questDir: string, rank: number): void {
	// Routed through the validated mutation core so a rank write is
	// validated and stamped the same way every other field write is.
	mutateQuestFrontMatter(questDir, (fm) => ({ ...fm, rank }));
}

/** Build a reverse alias index across every discovered quest. */
export function buildQuestsAliasIndex(state: QuestState): AliasIndex {
	const { index } = discoverQuests(state.questsRoot);
	return buildAliasIndex(index);
}

function writeQuestFrontMatter(
	questDir: string,
	mutate: (fm: QuestFrontMatter) => QuestFrontMatter | undefined,
): { ok: true; fm: QuestFrontMatter } | { ok: false; guidance: string } {
	const result = mutateQuestFrontMatter(questDir, mutate);
	if (!result.ok) return result;
	return { ok: true, fm: result.fm };
}

/**
 * Set a quest's parent by directory, stamping `updated` and
 * appending a Journey entry. Used by the reparent verb, which
 * may move quests other than the loaded one.
 */
export function setQuestParent(
	questDir: string,
	newParent: string | null,
): { ok: true } | { ok: false; guidance: string } {
	const result = writeQuestFrontMatter(questDir, (fm) => ({
		...fm,
		parent: newParent,
	}));
	if (!result.ok) return result;
	appendJourneyByPath(questDir, `Reparented to ${newParent ?? "top level"}.`);
	return { ok: true };
}

/** Set a quest's status by directory, stamping `updated`. */
export function setQuestStatusByDir(
	questDir: string,
	status: QuestFrontMatter["status"],
): { ok: true } | { ok: false; guidance: string } {
	const result = writeQuestFrontMatter(questDir, (fm) => ({ ...fm, status }));
	if (!result.ok) return result;
	return { ok: true };
}

/**
 * Set a quest's priority by directory (the by-id counterpart to
 * `setLoadedPriority`). Used by the bulk seal cascade and by undo
 * when it reverses a journalled priority change.
 */
export function setQuestPriorityByDir(
	questDir: string,
	priority: QuestFrontMatter["priority"],
): { ok: true } | { ok: false; guidance: string } {
	const result = writeQuestFrontMatter(questDir, (fm) => ({ ...fm, priority }));
	if (!result.ok) return result;
	return { ok: true };
}

/**
 * Add one or more aliases to the loaded quest in a single front-matter
 * write, so a list either lands whole or not at all and no partial
 * state survives a failure. Aliases already present, and duplicates
 * within the batch, are reported as already and added only once.
 */
export function addAliasesToLoaded(
	state: QuestState,
	aliases: QuestAlias[],
):
	| { ok: true; added: QuestAlias[]; already: QuestAlias[] }
	| { ok: false; guidance: string } {
	if (!state.questDir) return { ok: false, guidance: "Load a quest first." };
	let added: QuestAlias[] = [];
	let already: QuestAlias[] = [];
	const result = writeQuestFrontMatter(state.questDir, (fm) => {
		// Reset on every invocation so a retried write does not
		// accumulate duplicate report entries.
		added = [];
		already = [];
		const next = [...fm.aliases];
		for (const alias of aliases) {
			const present = next.some(
				(a) => a.type === alias.type && a.value === alias.value,
			);
			if (present) {
				already.push(alias);
				continue;
			}
			added.push(alias);
			next.push(alias);
		}
		return { ...fm, aliases: next };
	});
	if (!result.ok) return result;
	return { ok: true, added, already };
}

/** Remove an alias from the loaded quest. */
export function removeAliasFromLoaded(
	state: QuestState,
	alias: QuestAlias,
): { ok: true; removed: boolean } | { ok: false; guidance: string } {
	if (!state.questDir) return { ok: false, guidance: "Load a quest first." };
	let removed = false;
	const result = writeQuestFrontMatter(state.questDir, (fm) => {
		const next = fm.aliases.filter(
			(a) => !(a.type === alias.type && a.value === alias.value),
		);
		if (next.length === fm.aliases.length) return undefined;
		removed = true;
		return { ...fm, aliases: next };
	});
	if (!result.ok) return result;
	return { ok: true, removed };
}

/** Attach a pi session id to the loaded quest. */
export function attachSessionToLoaded(
	state: QuestState,
	session: QuestSession,
): { ok: true; added: boolean } | { ok: false; guidance: string } {
	if (!state.questDir) return { ok: false, guidance: "Load a quest first." };
	let added = false;
	const result = writeQuestFrontMatter(state.questDir, (fm) => {
		const existing = fm.sessions.find((s) => s.id === session.id);
		if (existing) {
			// Refresh status to active and merge any new fields, but keep
			// the original started: it records when the session first
			// touched this quest, not the latest attach. Letting the
			// incoming started win would defeat the no-op guard below and
			// churn the README on every load.
			const merged: QuestSession = {
				...existing,
				...session,
				started: existing.started ?? session.started,
				status: "active",
			};
			if (JSON.stringify(merged) === JSON.stringify(existing)) {
				return undefined;
			}
			return {
				...fm,
				sessions: fm.sessions.map((s) => (s.id === session.id ? merged : s)),
			};
		}
		added = true;
		const next: QuestSession = { status: "active", ...session };
		return { ...fm, sessions: [...fm.sessions, next] };
	});
	if (!result.ok) return result;
	return { ok: true, added };
}

/**
 * Attach the current pi session to the loaded quest.
 *
 * This is the automatic-capture path: the session_start and
 * load flows call it so a quest's sessions frontmatter records
 * where work happened without the user running session-attach by
 * hand. It refreshes an existing record rather than duplicating,
 * and no-ops cleanly when no quest is loaded or the session id is
 * unknown.
 */
export function attachCurrentSession(
	state: QuestState,
	opts: { id: string | undefined; cwd?: string; persisted?: boolean },
): { attached: boolean } {
	// An ephemeral session (pi --no-session) has an id but writes no
	// log, so attaching it would leave a phantom entry that can never
	// be resumed. Skip it; only a persisted session earns a record.
	if (opts.persisted === false) return { attached: false };
	if (!state.questDir || !opts.id) return { attached: false };
	const session: QuestSession = {
		id: opts.id,
		started: new Date().toISOString(),
		status: "active",
	};
	if (opts.cwd?.trim()) session.cwd = opts.cwd.trim();
	const result = attachSessionToLoaded(state, session);
	return { attached: result.ok };
}

/**
 * Drop no-log phantom sessions from the loaded quest's frontmatter.
 *
 * Ephemeral fan-outs that predate the attach guard left detached
 * ids with no log behind; this garbage-collects them when a quest
 * is loaded, so a quest self-heals on next touch. Only provable
 * phantoms go (detached and log-less); active and logged sessions
 * are untouched. No-ops when nothing is prunable.
 */
export function prunePhantomSessionsOnLoaded(state: QuestState): {
	removed: number;
} {
	if (!state.questDir) return { removed: 0 };
	const index = indexSessionFiles(sessionsDir());
	let removed = 0;
	writeQuestFrontMatter(state.questDir, (fm) => {
		const { kept, removed: gone } = prunePhantomSessions(fm.sessions, (id) =>
			index.has(id),
		);
		removed = gone.length;
		// Return undefined when nothing changed so writeQuestFrontMatter
		// skips the write: a no-op prune must not rewrite the README or
		// bump `updated` on every load.
		if (gone.length === 0) return undefined;
		return { ...fm, sessions: kept };
	});
	return { removed };
}

/** Mark a session as detached on the loaded quest. */
export function detachSessionFromLoaded(
	state: QuestState,
	sessionId: string,
): { ok: true; detached: boolean } | { ok: false; guidance: string } {
	if (!state.questDir) return { ok: false, guidance: "Load a quest first." };
	return detachSessionInQuestDir(state.questDir, sessionId);
}

/**
 * Mark a session detached on a specific quest dir, independent of
 * what is loaded. The switch path uses this to release a session
 * from the quest it is leaving, so one session does not read active
 * on every quest it ever touched.
 */
/**
 * Reconcile a session's membership so it reads active on exactly one
 * quest: detach the session from every quest other than the one being
 * kept. The switch path already releases the immediate prior quest;
 * this catches stragglers left by earlier runs or a lost state, so a
 * session never lingers active on several quests at once. Returns the
 * ids it detached the session from.
 */
export function reconcileSessionMembership(
	state: QuestState,
	sessionId: string,
	keepQuestId: string,
): string[] {
	const { index } = discoverQuests(state.questsRoot);
	const detachedFrom: string[] = [];
	for (const entry of index.quests.values()) {
		const fm = entry.doc.frontMatter;
		if (fm.id === keepQuestId) continue;
		const holdsActive = fm.sessions.some(
			(s) => s.id === sessionId && s.status !== "detached",
		);
		if (!holdsActive) continue;
		const result = detachSessionInQuestDir(entry.dir, sessionId);
		if (result.ok && result.detached) detachedFrom.push(fm.id);
	}
	return detachedFrom;
}

export function detachSessionInQuestDir(
	questDir: string,
	sessionId: string,
): { ok: true; detached: boolean } | { ok: false; guidance: string } {
	let detached = false;
	const result = writeQuestFrontMatter(questDir, (fm) => {
		let hit = false;
		const next = fm.sessions.map((s) => {
			if (s.id !== sessionId) return s;
			if (s.status === "detached") return s;
			hit = true;
			return { ...s, status: "detached" as const };
		});
		if (!hit) return undefined;
		detached = true;
		return { ...fm, sessions: next };
	});
	if (!result.ok) return result;
	return { ok: true, detached };
}

const PRIORITY_ORDER: QuestPriority[] = [
	"driving",
	"active",
	"queued",
	"bench",
	"someday",
];

/** Set the loaded quest's priority bucket. */
export function setLoadedPriority(
	state: QuestState,
	priority: QuestPriority,
): { ok: true; changed: boolean } | { ok: false; guidance: string } {
	if (!state.questDir) return { ok: false, guidance: "Load a quest first." };
	let changed = false;
	const result = writeQuestFrontMatter(state.questDir, (fm) => {
		if (fm.priority === priority) return undefined;
		changed = true;
		// Append to the end of the destination bucket rather than
		// colliding at rank 1: take the next free rank in the target
		// (parent, priority) group, excluding the quest being moved.
		const { index } = discoverQuests(state.questsRoot);
		const destRanks = siblingRanks(index, fm.parent ?? null, priority, fm.id);
		return { ...fm, priority, rank: nextRank(destRanks) };
	});
	if (!result.ok) return result;
	if (changed) {
		state.questPriority = priority;
	}
	return { ok: true, changed };
}

/**
 * Change the loaded quest's kind. A subquest needs a parent to rank
 * within, so refuse the move to subquest when the quest has none.
 * Returns whether the kind actually changed.
 */
export function setLoadedKind(
	state: QuestState,
	kind: QuestFrontMatter["kind"],
): { ok: true; changed: boolean } | { ok: false; guidance: string } {
	if (!state.questDir) return { ok: false, guidance: "Load a quest first." };
	let changed = false;
	let refusal: string | undefined;
	const result = writeQuestFrontMatter(state.questDir, (fm) => {
		if (fm.kind === kind) return undefined;
		if (kind === "subquest" && (fm.parent ?? null) === null) {
			refusal =
				"A subquest needs a parent to rank within; reparent it under a quest first.";
			return undefined;
		}
		changed = true;
		return { ...fm, kind };
	});
	if (refusal) return { ok: false, guidance: refusal };
	if (!result.ok) return result;
	return { ok: true, changed };
}

/** Shift the loaded quest one bucket up or down the priority ladder. */
export function bumpLoadedPriority(
	state: QuestState,
	direction: "up" | "down",
):
	| { ok: true; from: QuestPriority; to: QuestPriority }
	| { ok: false; guidance: string } {
	if (!state.questDir || !state.questPriority) {
		return { ok: false, guidance: "Load a quest first." };
	}
	const i = PRIORITY_ORDER.indexOf(state.questPriority);
	if (i < 0)
		return { ok: false, guidance: "Unknown priority on the loaded quest." };
	const step = direction === "up" ? -1 : 1;
	const j = Math.min(PRIORITY_ORDER.length - 1, Math.max(0, i + step));
	const next = PRIORITY_ORDER[j];
	const from = state.questPriority;
	if (next === from) return { ok: true, from, to: from };
	const result = setLoadedPriority(state, next);
	if (!result.ok) return result;
	return { ok: true, from, to: next };
}

/** Set the loaded quest's coarse status enum. */
export function setLoadedStatus(
	state: QuestState,
	status: QuestStatus,
): { ok: true; changed: boolean } | { ok: false; guidance: string } {
	if (!state.questDir) return { ok: false, guidance: "Load a quest first." };
	let changed = false;
	const result = writeQuestFrontMatter(state.questDir, (fm) => {
		if (fm.status === status) return undefined;
		changed = true;
		return { ...fm, status };
	});
	if (!result.ok) return result;
	if (changed) {
		state.questStatus = status;
	}
	return { ok: true, changed };
}

/** Rename a session on the loaded quest. */
export function renameSessionOnLoaded(
	state: QuestState,
	sessionId: string,
	name: string,
): { ok: true; renamed: boolean } | { ok: false; guidance: string } {
	if (!state.questDir) return { ok: false, guidance: "Load a quest first." };
	let renamed = false;
	const result = writeQuestFrontMatter(state.questDir, (fm) => {
		let hit = false;
		const next = fm.sessions.map((s) => {
			if (s.id !== sessionId) return s;
			if (s.name === name) return s;
			hit = true;
			return { ...s, name };
		});
		if (!hit) return undefined;
		renamed = true;
		return { ...fm, sessions: next };
	});
	if (!result.ok) return result;
	return { ok: true, renamed };
}

/**
 * Lifecycle operations for the quest workflow: load,
 * unload, focus, unfocus, restore on session start, persist
 * back to disk. The state object owns the projections; this
 * module bridges between disk artifacts and that state.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolContext,
} from "@mariozechner/pi-coding-agent";
import {
	type AliasIndex,
	buildAliasIndex,
} from "../../lib/internal/quest/alias-index.js";
import { appendJourneyByPath } from "../../lib/internal/quest/append-journey.js";
import { nowYmd } from "../../lib/internal/quest/dates.js";
import {
	discoverQuests,
	type QuestEntry,
} from "../../lib/internal/quest/discovery.js";
import {
	atomicWriteFile,
	atomicWriteUnderLock,
	withQuestLock,
} from "../../lib/internal/quest/io.js";
import {
	diffRanks,
	type RankEntry,
	after as rankAfter,
	before as rankBefore,
	bottom as rankBottom,
	bump as rankBump,
	renumber as rankRenumber,
	sink as rankSink,
	top as rankTop,
} from "../../lib/internal/quest/ranking.js";
import { getLastEntry } from "../../lib/internal/state.js";
import {
	checkboxProgress,
	type DocumentFrontMatter,
	type DocumentKind,
	type DocumentStage,
	parseDocumentFrontMatter,
	parseQuestDoc,
	parseQuestFrontMatter,
	type QuestAlias,
	type QuestFrontMatter,
	type QuestPriority,
	type QuestSession,
	type QuestStatus,
	serializeDocumentFrontMatter,
	serializeQuestFrontMatter,
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
}

/** Unload the currently loaded quest. */
export function unloadQuest(state: QuestState): void {
	state.questDir = null;
	state.questId = null;
	state.questTitle = null;
	state.questKind = null;
	state.questStatus = null;
	state.questPriority = null;
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
export function writeDocumentStage(state: QuestState, stage: Stage): void {
	if (!state.documentPath) return;
	const questDir = state.questDir;
	let text: string;
	try {
		text = readFileSync(state.documentPath, "utf8");
	} catch {
		return;
	}
	const parsed = parseDocumentFrontMatter(text);
	if (!parsed) return;
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
	const questDir = state.questDir;
	const path = join(questDir, "README.md");
	withQuestLock(questDir, () => {
		let text: string;
		try {
			text = readFileSync(path, "utf8");
		} catch {
			return;
		}
		const parsed = parseQuestFrontMatter(text);
		if (!parsed) return;
		const fm: QuestFrontMatter = {
			...parsed.frontMatter,
			updated: nowYmd(),
		};
		atomicWriteFile(path, `${serializeQuestFrontMatter(fm)}\n${parsed.body}`);
	});
}

/**
 * Canonicalize a path for prefix comparison: resolve
 * symlinks, normalize `/var` vs `/private/var` on macOS,
 * and lowercase on case-insensitive filesystems where the
 * runtime can detect them. Returns the input on failure so
 * a missing path still compares against something stable.
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
	return child.startsWith(`${parent}/`);
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
	//    inside a quest's own folder.
	for (const entry of index.quests.values()) {
		if (isUnder(cwd, canonicalForCompare(entry.dir))) {
			loadQuest(state, pi, entry.doc.frontMatter.id);
			return;
		}
	}
	// 2. Tree-alias match: the cwd is inside a working
	//    tree registered on some quest. Walk every quest's
	//    `git-worktree:` aliases (path values) and the
	//    quest's `trees:` array; pick the deepest match so
	//    nested trees resolve to the innermost owner. Each
	//    candidate path is canonicalized so /var and
	//    /private/var (and bind-mounts in containers) match.
	let bestQuestId: string | undefined;
	let bestMatchLen = -1;
	const consider = (questId: string, treePath: string) => {
		const real = canonicalForCompare(treePath);
		if (isUnder(cwd, real) && real.length > bestMatchLen) {
			bestMatchLen = real.length;
			bestQuestId = questId;
		}
	};
	for (const entry of index.quests.values()) {
		const fm = entry.doc.frontMatter;
		for (const a of fm.aliases) {
			if (a.type === "git-worktree") consider(fm.id, a.value);
		}
		for (const tree of fm.trees ?? []) consider(fm.id, tree.path);
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
	const siblings: QuestEntry[] = [];
	for (const entry of index.quests.values()) {
		if (
			entry.doc.frontMatter.parent === pivot.doc.frontMatter.parent &&
			entry.doc.frontMatter.priority === pivot.doc.frontMatter.priority
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
	const path = join(questDir, "README.md");
	withQuestLock(questDir, () => {
		let text: string;
		try {
			text = readFileSync(path, "utf8");
		} catch {
			return;
		}
		const parsed = parseQuestFrontMatter(text);
		if (!parsed) return;
		const fm: QuestFrontMatter = {
			...parsed.frontMatter,
			rank,
			updated: nowYmd(),
		};
		atomicWriteFile(path, `${serializeQuestFrontMatter(fm)}\n${parsed.body}`);
	});
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
	const path = join(questDir, "README.md");
	return withQuestLock(questDir, () => {
		let text: string;
		try {
			text = readFileSync(path, "utf8");
		} catch (err) {
			return {
				ok: false as const,
				guidance: `Cannot read ${path}: ${(err as Error).message}`,
			};
		}
		const parsed = parseQuestFrontMatter(text);
		if (!parsed) {
			return {
				ok: false as const,
				guidance: `Quest README ${path} has invalid frontmatter.`,
			};
		}
		const next = mutate(parsed.frontMatter);
		if (!next) return { ok: true as const, fm: parsed.frontMatter };
		const withStamp: QuestFrontMatter = { ...next, updated: nowYmd() };
		atomicWriteFile(
			path,
			`${serializeQuestFrontMatter(withStamp)}\n${parsed.body}`,
		);
		return { ok: true as const, fm: withStamp };
	});
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

/** Add an alias to the loaded quest. No-op if already present. */
export function addAliasToLoaded(
	state: QuestState,
	alias: QuestAlias,
): { ok: true; added: boolean } | { ok: false; guidance: string } {
	if (!state.questDir) return { ok: false, guidance: "Load a quest first." };
	let added = false;
	const result = writeQuestFrontMatter(state.questDir, (fm) => {
		if (
			fm.aliases.some((a) => a.type === alias.type && a.value === alias.value)
		) {
			return undefined;
		}
		added = true;
		return { ...fm, aliases: [...fm.aliases, alias] };
	});
	if (!result.ok) return result;
	return { ok: true, added };
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
	opts: { id: string | undefined; cwd?: string },
): { attached: boolean } {
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

/** Mark a session as detached on the loaded quest. */
export function detachSessionFromLoaded(
	state: QuestState,
	sessionId: string,
): { ok: true; detached: boolean } | { ok: false; guidance: string } {
	if (!state.questDir) return { ok: false, guidance: "Load a quest first." };
	let detached = false;
	const result = writeQuestFrontMatter(state.questDir, (fm) => {
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
		return { ...fm, priority, rank: 1 };
	});
	if (!result.ok) return result;
	if (changed) {
		state.questPriority = priority;
	}
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

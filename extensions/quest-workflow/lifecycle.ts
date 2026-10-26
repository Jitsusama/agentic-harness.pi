/**
 * Lifecycle operations for the quest workflow: load,
 * unload, focus, unfocus, restore on session start, persist
 * back to disk. The state object owns the projections; this
 * module bridges between disk artifacts and that state.
 *
 * The state-only mutations (refresh, focus/unfocus, document
 * stage, journey entries, aliasing, reordering, priority/
 * status/kind, session attach/detach, worktree inventory) are
 * re-exported from agentic-harness.core -- see that package's
 * quest/lifecycle.ts for the full set and why they moved.
 * What stays here needs pi's own ExtensionAPI (to set the
 * session name), pi's session log (to persist and restore the
 * loaded quest across a pi session and to prune phantom
 * sessions against it), neither of which any other adapter has.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	captureSessionIdentity,
	detachSessionIfOwner,
	findQuestEntry,
	focusDocument,
	refreshProgress,
	stampQuestUpdated,
	unfocusDocument,
} from "../../lib/core/quest/lifecycle.ts";
import { sessionsDir } from "../../lib/internal/paths.ts";
import { appendJourneyByPath } from "../../lib/internal/quest/append-journey.ts";
import { discoverQuests } from "../../lib/internal/quest/discovery.ts";
import { appendHarnessLog } from "../../lib/internal/quest/harness-log.ts";
import { mutateQuestFrontMatter } from "../../lib/internal/quest/mutate.ts";
import { questIdForCwd } from "../../lib/internal/quest/resolve-cwd.ts";
import {
	indexSessionFiles,
	prunePhantomSessions,
} from "../../lib/internal/quest/session-liveness.ts";
import { getLastEntry } from "../../lib/internal/state.ts";
import { sessionNameFor } from "./render.ts";
import type { QuestState } from "./state.ts";

export {
	addAliasesToLoaded,
	attachCurrentSession,
	attachSessionToLoaded,
	buildQuestsAliasIndex,
	bumpLoadedPriority,
	captureSessionIdentity,
	createDocument,
	detachSessionFromLoaded,
	detachSessionIfOwner,
	detachSessionInQuestDir,
	ensureQuestsRoot,
	findQuestEntry,
	focusDocument,
	inventoryWorktrees,
	listAllQuests,
	type RankAction,
	type ReorderResult,
	reconcileSessionMembership,
	refreshLoadedSlice,
	refreshProgress,
	removeAliasesFromLoaded,
	removeAliasFromLoaded,
	renameSessionOnLoaded,
	reorderSiblings,
	sealQuestDocuments,
	setLoadedKind,
	setLoadedPriority,
	setLoadedStatus,
	setQuestFieldByDir,
	setQuestParent,
	setQuestPriorityByDir,
	setQuestRankByDir,
	setQuestStatusByDir,
	stampQuestUpdated,
	unfocusDocument,
	unloadQuest,
	type WorktreeInventoryEntry,
	writeDocumentStage,
} from "../../lib/core/quest/lifecycle.ts";

/**
 * Add an entry to the loaded quest's Journey and stamp it updated.
 * The harness's own rather than core's, which still writes into the
 * README: this one writes the Journey file (see
 * lib/internal/quest/journey.ts).
 */
export function appendJourneyEntry(state: QuestState, prose: string): boolean {
	if (!state.questDir) return false;
	// A quest with no README is one discovery reports at session start,
	// through the screen; saying it again here would go to the console,
	// which lands in pi's editor (lib/ui/aside.ts).
	if (!appendJourneyByPath(state.questDir, prose)) return false;
	stampQuestUpdated(state);
	return true;
}

/**
 * Note bookkeeping the harness did for the loaded quest in its
 * harness log, which keeps it out of the Journey sessions read.
 */
export function logHarnessEntry(state: QuestState, text: string): boolean {
	if (!state.questDir) return false;
	return appendHarnessLog(state.questDir, text);
}

/**
 * Mark a session detached on the loaded quest as its process shuts
 * down, unless another process has since taken it over.
 *
 * The lease compares the instance id attach stored with this
 * process's own, so both have to come from the same place. Attach
 * captures it through core's `captureSessionIdentity`, so this does
 * too. Reading it from the extension's own copy of the liveness module
 * gave a different id per copy, which made every shutdown believe
 * another process owned the session and left every README showing
 * its tabs active after they were gone.
 */
export function releaseSessionOnShutdown(
	state: QuestState,
	sessionId: string,
): void {
	if (!state.questDir) return;
	const { instanceId } = captureSessionIdentity();
	detachSessionIfOwner(state.questDir, sessionId, instanceId);
}

/**
 * A quest's short name. Core's parser, which `findQuestEntry` uses until
 * core folds into this package, does not know the field and keeps it
 * among the extras; the harness's own parser reads it directly.
 */
function shortNameOf(frontMatter: {
	short?: unknown;
	_extra?: Record<string, unknown>;
}): string | undefined {
	const short = frontMatter.short ?? frontMatter._extra?.short;
	return typeof short === "string" ? short : undefined;
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
	state.questVerify = entry.doc.frontMatter.verify ?? null;
	state.scratchDir = entry.doc.frontMatter.scratchDir ?? null;
	state.documentPath = null;
	state.documentId = null;
	state.documentKind = null;
	state.documentTitle = null;
	state.documentStage = "idle";
	refreshProgress(state);
	const sessionName = sessionNameFor(
		entry.doc.title ?? null,
		shortNameOf(entry.doc.frontMatter),
	);
	if (sessionName) pi.setSessionName?.(sessionName);
	return { ok: true };
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
	/**
	 * The loaded quest's verification command, mirrored from its
	 * frontmatter so a peer extension can read it from this entry
	 * without parsing the quest.
	 */
	verify?: string | null;
	/**
	 * True when the person or the agent unfocused the plan on purpose,
	 * so a reload does not focus it again behind their back.
	 */
	unfocused?: true;
}

function snapshot(state: QuestState, cwd: string | null): PersistedState {
	return {
		questId: state.questId,
		documentPath: state.documentPath,
		cwd,
		verify: state.questVerify,
		...(!state.documentPath && unfocusedOnPurpose.has(state)
			? { unfocused: true as const }
			: {}),
	};
}

/** Sessions whose plan was unfocused deliberately rather than never focused. */
const unfocusedOnPurpose = new WeakMap<QuestState, true>();

/**
 * Record whether the focused plan was put down on purpose. Set by
 * `unfocus`; cleared by `focus` and by loading a quest.
 */
export function setUnfocusedOnPurpose(state: QuestState, on: boolean): void {
	if (on) unfocusedOnPurpose.set(state, true);
	else unfocusedOnPurpose.delete(state);
}

/** Stages in which a plan is still being worked. */
const ACTIVE_STAGES: ReadonlySet<string> = new Set(["think", "draft", "build"]);

/** What {@link autoFocusPlan} did. */
export type AutoFocus =
	| { kind: "focused"; id: string; stage: string }
	| { kind: "choose"; ids: string[] }
	| { kind: "none" };

/**
 * Focus the plan this quest is being worked through, when there is
 * one to name: its primary plan while that is still active, otherwise
 * its only active plan. Several active plans and no usable primary is
 * a choice for whoever is working, so it is said rather than guessed.
 *
 * Work used to run with a quest loaded and no plan focused, because
 * loading a quest always cleared the focus and nothing put it back.
 */
export function autoFocusPlan(state: QuestState): AutoFocus {
	if (!state.questId || state.documentPath) return { kind: "none" };
	const entry = findQuestEntry(state, state.questId);
	if (!entry) return { kind: "none" };
	const active = entry.documents.filter(
		(d) =>
			d.doc.frontMatter.kind === "plan" &&
			ACTIVE_STAGES.has(d.doc.frontMatter.stage),
	);
	const primaryId = entry.doc.frontMatter.primaryPlanId;
	const chosen =
		active.find((d) => d.doc.frontMatter.id === primaryId) ??
		(active.length === 1 ? active[0] : undefined);
	if (chosen) {
		if (!focusDocument(state, chosen.path).ok) return { kind: "none" };
		return {
			kind: "focused",
			id: chosen.doc.frontMatter.id,
			stage: chosen.doc.frontMatter.stage,
		};
	}
	if (active.length > 1) {
		return { kind: "choose", ids: active.map((d) => d.doc.frontMatter.id) };
	}
	return { kind: "none" };
}

/** One sentence saying what {@link autoFocusPlan} did, or nothing. */
export function autoFocusSaid(focus: AutoFocus): string | undefined {
	if (focus.kind === "focused") {
		const next =
			focus.stage === "build"
				? ""
				: `; it is in ${focus.stage}, so \`build\` before implementing`;
		return `Focused plan ${focus.id}${next}.`;
	}
	if (focus.kind === "choose") {
		return `${focus.ids.length} active plans (${focus.ids.join(", ")}); focus the one being worked.`;
	}
	return undefined;
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
 * reads the same data; it just doesn't have a fresh
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
	return `${s.questId ?? ""}|${s.documentPath ?? ""}|${s.cwd ?? ""}|${s.verify ?? ""}|${s.unfocused ? "u" : ""}`;
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
	if (!saved?.questId) return false;
	const result = loadQuest(state, pi, saved.questId);
	if (!result.ok) return false;
	if (saved.documentPath) {
		// The quest is loaded; try to restore the focused
		// document. A missing or unparsable document is not
		// fatal: the quest stays loaded and the user re-focuses
		// if they care to. A plan concluded since is not worth
		// focusing again; the active one is.
		focusDocument(state, saved.documentPath);
		if (state.documentPath && !ACTIVE_STAGES.has(state.documentStage)) {
			unfocusDocument(state);
		}
	}
	if (saved.unfocused && !state.documentPath) {
		setUnfocusedOnPurpose(state, true);
	} else {
		autoFocusPlan(state);
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
			autoFocusPlan(state);
			return { source: "explicit", questId: state.questId };
		}
	}
	if (restore(state, pi, ctx)) {
		return { source: "persisted", questId: state.questId };
	}
	// The cwd walk is the only path that attaches a fresh session
	// it never chose. When the user disables it, a fresh session
	// stays idle rather than adopting whatever quest happens to
	// own the working tree, which keeps unrelated sessions off the
	// quest's session list.
	if (state.autoloadFromCwd) {
		restoreFromCwd(state, pi, ctx);
		autoFocusPlan(state);
	}
	return {
		source: state.questId ? "cwd" : "none",
		questId: state.questId,
	};
}

/** Restore on session_start by re-reading from disk if a quest dir was remembered. */
export function restoreFromCwd(
	state: QuestState,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): void {
	const rawCwd = ctx.cwd;
	if (!rawCwd) return;
	const { index } = discoverQuests(state.questsRoot);
	const questId = questIdForCwd(index, rawCwd);
	if (questId) loadQuest(state, pi, questId);
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
	mutateQuestFrontMatter(state.questDir, (fm) => {
		const { kept, removed: gone } = prunePhantomSessions(fm.sessions, (id) =>
			index.has(id),
		);
		removed = gone.length;
		// Return undefined when nothing changed so the write is
		// skipped: a no-op prune must not rewrite the README or
		// bump `updated` on every load.
		if (gone.length === 0) return undefined;
		return { ...fm, sessions: kept };
	});
	return { removed };
}

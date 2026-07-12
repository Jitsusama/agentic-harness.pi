/**
 * A durable record of which pi sessions were open together in one
 * terminal workspace, so a restart can reconstruct the set that live
 * pane enumeration can no longer see once the panes are gone.
 *
 * The store is keyed by an opaque workspace key (the terminal mux
 * scope, which groups the panes of one terminal instance). Each key
 * holds one entry per session, updated whenever a session explicitly
 * loads or reopens a quest. Nothing here probes or mutates a quest;
 * it is a side record the restore verb reads.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** One session recorded as open in a workspace. */
export interface WorkspaceEntry {
	questId: string;
	cwd: string;
	sessionId: string;
	/** Terminal surface value (pane id), for live-pane exclusion. */
	pane?: string;
	/** When this entry was last recorded. */
	updated: string;
}

/** The set of sessions last seen open together under one key. */
export interface WorkspaceSnapshot {
	key: string;
	updated: string;
	entries: WorkspaceEntry[];
}

/** The whole store: workspace key to its snapshot. */
export type WorkspaceStore = Record<string, WorkspaceSnapshot>;

/** Fields a caller records for a session. */
export interface RecordInput {
	questId: string;
	cwd: string;
	sessionId: string;
	pane?: string;
	now: string;
}

const MAX_ENTRIES_PER_WORKSPACE = 24;

/**
 * Record a session as open under a workspace key, returning a new
 * store. A session already recorded under the key is updated in
 * place rather than duplicated, so the snapshot always holds one
 * entry per session, and the oldest entries are dropped past the
 * per-workspace cap so the store cannot grow without bound.
 */
export function recordWorkspaceEntry(
	store: WorkspaceStore,
	key: string,
	input: RecordInput,
): WorkspaceStore {
	const existing = store[key]?.entries ?? [];
	const entry: WorkspaceEntry = {
		questId: input.questId,
		cwd: input.cwd,
		sessionId: input.sessionId,
		...(input.pane ? { pane: input.pane } : {}),
		updated: input.now,
	};
	const kept = existing.filter((e) => e.sessionId !== entry.sessionId);
	kept.push(entry);
	// Newest last; when over the cap, drop from the front (oldest).
	const trimmed = kept
		.sort((a, b) => Date.parse(a.updated) - Date.parse(b.updated))
		.slice(-MAX_ENTRIES_PER_WORKSPACE);
	return {
		...store,
		[key]: { key, updated: input.now, entries: trimmed },
	};
}

/** The recorded snapshot for one workspace key, or undefined. */
export function snapshotFor(
	store: WorkspaceStore,
	key: string,
): WorkspaceSnapshot | undefined {
	return store[key];
}

/** Read the store from disk, treating a missing or bad file as empty. */
export function loadWorkspaceStore(path: string): WorkspaceStore {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		// No store yet, or unreadable: an empty store reads the same as
		// "nothing was ever recorded here."
		return {};
	}
	try {
		const parsed = JSON.parse(text);
		if (typeof parsed === "object" && parsed !== null) {
			return parsed as WorkspaceStore;
		}
	} catch {
		// Corrupt JSON: discard rather than crash the reader.
	}
	return {};
}

/** Write the store to disk, creating the parent directory on demand. */
export function saveWorkspaceStore(path: string, store: WorkspaceStore): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`);
}

export interface RestorePlan {
	toRestore: WorkspaceEntry[];
	alreadyLive: WorkspaceEntry[];
}

/**
 * Split a snapshot into the sessions to restore and those already
 * live. An entry whose recorded pane is in the live set is dropped
 * from the restore plan, so restore never re-opens a pane that is
 * still on screen. Entries with no recorded pane cannot be excluded
 * and are always offered for restore.
 */
export function planWorkspaceRestore(
	snapshot: WorkspaceSnapshot,
	livePanes: ReadonlySet<string>,
): RestorePlan {
	const toRestore: WorkspaceEntry[] = [];
	const alreadyLive: WorkspaceEntry[] = [];
	for (const entry of snapshot.entries) {
		if (entry.pane && livePanes.has(entry.pane)) alreadyLive.push(entry);
		else toRestore.push(entry);
	}
	return { toRestore, alreadyLive };
}

/**
 * A printable recipe that reopens each session in its own directory,
 * the fallback path when the terminal cannot be driven directly.
 */
export function restoreRecipe(entries: readonly WorkspaceEntry[]): string[] {
	return entries.map(
		(e) => `(cd ${e.cwd} && pi --session ${e.sessionId})  # ${e.questId}`,
	);
}

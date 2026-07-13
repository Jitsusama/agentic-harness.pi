/**
 * Real-dependency wiring for the durable workspace snapshot.
 *
 * The pure store in `lib/internal/quest/workspace-snapshot` records
 * which sessions were open together under a workspace key and plans a
 * restore. This module supplies the live pieces: the workspace key
 * and pane value read from the current terminal, the on-disk store
 * path, the recording call the load path fires, and the live-pane
 * probe the restore verb uses to exclude panes still on screen.
 */

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateDir } from "../../lib/internal/paths.js";
import { withQuestLock } from "../../lib/internal/quest/io.js";
import {
	loadWorkspaceStore,
	planWorkspaceRestore,
	type RestorePlan,
	recordWorkspaceEntry,
	restoreRecipe,
	saveWorkspaceStore,
	snapshotFor,
	type WorkspaceSnapshot,
} from "../../lib/internal/quest/workspace-snapshot.js";
import {
	identifyCurrentTerminal,
	type TerminalSessionHandle,
} from "../../lib/terminal/index.js";
import { probeLivePaneValues } from "./liveness.js";

/** Where the durable workspace store lives. */
export function workspaceSnapshotPath(): string {
	return join(stateDir("quest-workflow"), "workspace-snapshots.json");
}

/**
 * The workspace key and pane for the current terminal, or undefined
 * when there is no probeable terminal to key a snapshot by. The key
 * is the driver plus mux scope, which groups the panes of one
 * terminal instance.
 */
function currentWorkspace():
	| { key: string; handle: TerminalSessionHandle }
	| undefined {
	const handle = identifyCurrentTerminal();
	if (!handle?.scope) return undefined;
	// Include the host: a mux socket path is host-local, so two hosts
	// could otherwise reuse the same path and collide in the store.
	return {
		key: `${handle.hostId}:${handle.driverId}:${handle.scope}`,
		handle,
	};
}

/**
 * Record the current session as open in its terminal workspace. A
 * best-effort side write fired when a session explicitly loads or
 * reopens a quest; a missing terminal or a write failure is
 * swallowed so recording never breaks a load.
 */
export function recordCurrentWorkspace(input: {
	questId: string;
	sessionId: string;
	cwd: string;
}): void {
	const current = currentWorkspace();
	if (!current) return;
	try {
		const path = workspaceSnapshotPath();
		const dir = dirname(path);
		mkdirSync(dir, { recursive: true });
		// Serialize the load-modify-save across panes: two sessions
		// recording at once would otherwise lose one entry to a last-
		// writer-wins race. The lock is the same advisory file-creation
		// lock the quest READMEs use.
		withQuestLock(dir, () => {
			const store = loadWorkspaceStore(path);
			const next = recordWorkspaceEntry(store, current.key, {
				questId: input.questId,
				cwd: input.cwd,
				sessionId: input.sessionId,
				pane: current.handle.value,
				now: new Date().toISOString(),
			});
			saveWorkspaceStore(path, next);
		});
	} catch {
		// A side record must never break the load that triggered it.
	}
}

/** The restore view: the snapshot, the live-pane-excluded plan, and a recipe. */
export interface WorkspaceRestoreView {
	snapshot: WorkspaceSnapshot;
	plan: RestorePlan;
	recipe: string[];
}

/**
 * Plan a restore for the current terminal's workspace. Returns a
 * reason string when there is no terminal to key by or no snapshot
 * recorded for it, otherwise the snapshot, the plan (with panes still
 * live excluded) and the printable recipe.
 */
export async function planCurrentWorkspaceRestore(): Promise<
	WorkspaceRestoreView | { reason: string }
> {
	const current = currentWorkspace();
	if (!current) {
		return {
			reason:
				"Restore needs a terminal that reports a workspace; none is active here.",
		};
	}
	const store = loadWorkspaceStore(workspaceSnapshotPath());
	const snapshot = snapshotFor(store, current.key);
	if (!snapshot || snapshot.entries.length === 0) {
		return { reason: "No workspace snapshot recorded for this terminal." };
	}
	const panes = snapshot.entries
		.map((e) => e.pane)
		.filter((p): p is string => Boolean(p));
	const live = await probeLivePaneValues(current.handle, panes);
	const plan = planWorkspaceRestore(snapshot, live);
	return { snapshot, plan, recipe: restoreRecipe(plan.toRestore) };
}

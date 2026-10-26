/**
 * A quest's workspace, under the root `lib/internal/quest/workspace-root.ts`
 * names.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statfsSync } from "node:fs";
import { dirname } from "node:path";
import { questWorkspace } from "../../lib/core/internal/quest/workspace.ts";
import { isId, prefixOf } from "../../lib/internal/quest/id.ts";
import { questWorkspacesRoot } from "../../lib/internal/quest/workspace-root.ts";

/** Where quests' workspaces live, honouring `XDG_CACHE_HOME`. */
export const defaultWorkspaceRoot = questWorkspacesRoot;

/**
 * A quest's workspace folder, or undefined for an ID that cannot name
 * one, which only a hand-built state has.
 */
export function workspaceDirOf(
	root: string,
	questId: string | null,
): string | undefined {
	if (!questId || !isId(questId) || prefixOf(questId) !== "QEST") return;
	return questWorkspace(root, questId).dir;
}

/** How a workspace's own folder is made. */
export interface WorkspaceFolders {
	/** Whether `dir`, or the nearest folder above it, is on btrfs. */
	readonly onBtrfs: (dir: string) => boolean;
	/** Makes `dir` as a btrfs subvolume, saying whether it could. */
	readonly subvolume: (dir: string) => boolean;
}

/** What `statfs` reports for a btrfs filesystem. */
const BTRFS_MAGIC = 0x9123683e;

/** The folders this machine makes: subvolumes through `btrfs`, no root needed. */
export const btrfsFolders: WorkspaceFolders = {
	onBtrfs: (dir) => {
		let at = dir;
		while (!existsSync(at) && dirname(at) !== at) at = dirname(at);
		try {
			return statfsSync(at).type === BTRFS_MAGIC;
		} catch {
			return false;
		}
	},
	subvolume: (dir) =>
		spawnSync("btrfs", ["subvolume", "create", dir], {
			stdio: "ignore",
			timeout: 10_000,
		}).status === 0,
};

/**
 * Makes a quest's workspace folder at `dir` if there is none.
 *
 * On btrfs it is a subvolume of its own, since every file in one
 * subvolume shares its tree lock and log: with agents' builds in @home,
 * an app's save beside 20 cargo builds took p99 600 ms, and 18 ms with
 * the builds in a subvolume apart. Off btrfs, or when one can't be made,
 * it is a plain folder. A workspace already made is left as it is, and
 * removing one needs nothing new, since its owner may remove an empty
 * subvolume as it would a folder.
 */
export function makeWorkspace(
	dir: string,
	folders: WorkspaceFolders = btrfsFolders,
): void {
	if (existsSync(dir)) return;
	const root = dirname(dir);
	mkdirSync(root, { recursive: true });
	if (folders.onBtrfs(root) && folders.subvolume(dir)) return;
	mkdirSync(dir, { recursive: true });
}

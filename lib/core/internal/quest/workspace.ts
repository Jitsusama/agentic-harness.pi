/**
 * A quest's workspace: where everything a quest makes that is not its
 * record lives, such as clones, raw data, labs, runs and builds.
 *
 * It sits outside the quests folder, under a root the adapter chooses
 * (pi's is its cache directory), in a folder named by the quest's ID, so
 * anything outside pi can find a workspace's quest by name alone. Its
 * `tmp/` takes the ad-hoc writes that would otherwise land in system
 * temp. A conclude removes the whole workspace, since a cache goes with
 * its owner rather than waiting on an age: what is worth keeping moves
 * to the quest's attachments first. The disk guard reclaims one left
 * behind, as when a process still used it.
 */

import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readlinkSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { join, sep } from "node:path";
import { isId, prefixOf } from "../../../internal/quest/id.ts";

/** A quest's workspace folder and its `tmp/`. */
export interface QuestWorkspace {
	readonly dir: string;
	readonly tmp: string;
}

/**
 * Where a quest's workspace is. Refuses anything that is not a quest's
 * ID, since the folder is created and emptied by name and a name like
 * `../x` would reach outside the root.
 */
export function questWorkspace(root: string, questId: string): QuestWorkspace {
	if (!isId(questId) || prefixOf(questId) !== "QEST") {
		throw new Error(`"${questId}" is not a quest ID.`);
	}
	const dir = join(root, questId);
	return { dir, tmp: join(dir, "tmp") };
}

/** A quest's `tmp/`, created on first need. */
export function ensureQuestWorkspaceTmp(root: string, questId: string): string {
	const { tmp } = questWorkspace(root, questId);
	mkdirSync(tmp, { recursive: true });
	return tmp;
}

/** What removing a quest's workspace came to. */
export type WorkspaceRemoval =
	| { readonly removed: true }
	| { readonly removed: false; readonly why: "none" | "in use" | "stuck" };

/**
 * Remove a quest's whole workspace, unless a process still works in it:
 * one whose folder or open file is inside keeps it, for the disk guard
 * to take once it is done. A folder made read-only, as Go's module cache
 * is, is made writable so its files can go.
 */
export function removeQuestWorkspace(
	root: string,
	questId: string,
	users: (dir: string) => readonly number[] = processesIn,
): WorkspaceRemoval {
	const { dir } = questWorkspace(root, questId);
	if (!existsSync(dir)) return { removed: false, why: "none" };
	if (users(dir).length > 0) return { removed: false, why: "in use" };
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		try {
			makeWritable(dir);
			rmSync(dir, { recursive: true, force: true });
		} catch {
			return { removed: false, why: "stuck" };
		}
	}
	return { removed: true };
}

/** Every folder under `dir`, and `dir`, writable by its owner. */
function makeWritable(dir: string): void {
	chmodSync(dir, 0o700);
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) makeWritable(join(dir, entry.name));
	}
}

/**
 * The processes whose working folder or an open file is inside `dir`,
 * read from `/proc`. None where there is no `/proc`, as on a Mac.
 */
export function processesIn(dir: string): number[] {
	let real: string;
	try {
		real = realpathSync(dir);
	} catch {
		return [];
	}
	const inside = (path: string) => path === real || path.startsWith(real + sep);
	let pids: string[];
	try {
		pids = readdirSync("/proc").filter((name) => /^\d+$/.test(name));
	} catch {
		return [];
	}
	return pids
		.filter((pid) => {
			if (inside(linkOf(`/proc/${pid}/cwd`))) return true;
			let fds: string[];
			try {
				fds = readdirSync(`/proc/${pid}/fd`);
			} catch {
				// Another account's process, or one gone since: not ours to keep.
				return false;
			}
			return fds.some((fd) => inside(linkOf(`/proc/${pid}/fd/${fd}`)));
		})
		.map(Number);
}

/** Where a `/proc` link points, or nothing once it is gone. */
function linkOf(path: string): string {
	try {
		return readlinkSync(path);
	} catch {
		return "";
	}
}

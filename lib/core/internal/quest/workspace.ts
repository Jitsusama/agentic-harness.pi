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
	existsSync,
	mkdirSync,
	readdirSync,
	readlinkSync,
	realpathSync,
} from "node:fs";
import { join, sep } from "node:path";
import {
	removerFolders,
	removeTreeOff,
} from "../../../internal/files/remove-tree.ts";
import { isId, prefixOf } from "../../../internal/quest/creation/id.ts";
import { conversationsIn } from "../../../internal/session/host-holds.ts";

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
	| { readonly removed: false; readonly why: "none" | "in use" }
	| { readonly removed: false; readonly why: "stuck"; readonly error: unknown };

/**
 * Who works in a folder: a process by its pid, a hosted conversation by
 * its session id.
 */
export type WorkspaceUsers = (dir: string) => readonly (number | string)[];

/**
 * Remove a quest's whole workspace, unless something still works in it:
 * a process whose folder or open file is inside, or a hosted
 * conversation whose folder is, keeps it for the disk guard to take once
 * it is done. One that can't all go is left under its name, for the disk
 * guard to take what is left. Once begun it finishes, though the conclude
 * that asked is called off, since half a cache is worth nothing.
 */
export async function removeQuestWorkspace(
	root: string,
	questId: string,
	users: WorkspaceUsers = workingIn,
): Promise<WorkspaceRemoval> {
	const { dir } = questWorkspace(root, questId);
	if (!existsSync(dir)) return { removed: false, why: "none" };
	if (users(dir).length > 0) return { removed: false, why: "in use" };
	// The system's `rm`, off the thread: a walk on pi's own thread held a
	// host for 7 s on 19 Nov, and one by path follows a link a fenced
	// command swaps in mid-walk (remove-tree.ts). A workspace is scratch,
	// so read-only folders in it, as Go's module cache makes, go too.
	try {
		await removeTreeOff(dir, removerFolders(), { evenReadOnly: true });
	} catch (error) {
		return { removed: false, why: "stuck", error };
	}
	return { removed: true };
}

/**
 * Everything working in `dir`: the processes `/proc` shows there, and the
 * conversations a host keeps there. A host's own process works wherever
 * it was started, so a hosted conversation open on a clone in the
 * workspace shows only on its host's roster.
 */
export function workingIn(dir: string): (number | string)[] {
	return [...processesIn(dir), ...conversationsIn(dir)];
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

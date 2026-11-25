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
import * as promises from "node:fs/promises";
import { join, sep } from "node:path";
import { isId, prefixOf } from "../../../internal/quest/creation/id.ts";
import { conversationsIn } from "../../../internal/session/host-holds.ts";

/**
 * The folder in a quest's workspace that takes its ad-hoc writes, which
 * its `TMPDIR` link leads to outside the fence and in it.
 */
export const WORKSPACE_TEMP_FOLDER = "tmp";

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
	return { dir, tmp: join(dir, WORKSPACE_TEMP_FOLDER) };
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
	try {
		await removeTree(dir);
	} catch (error) {
		return { removed: false, why: "stuck", error };
	}
	return { removed: true };
}

/** What a removal needs to know of a thing on disk. */
interface Found {
	isDirectory(): boolean;
}

/** The filesystem calls a removal makes. */
export interface TreeRemovalCalls {
	lstat(path: string): Promise<Found>;
	chmod(path: string, mode: number): Promise<void>;
	/** A folder's entries, each named and saying whether it's a folder. */
	entries(dir: string): Promise<readonly (Found & { name: string })[]>;
	rmdir(path: string): Promise<void>;
	unlink(path: string): Promise<void>;
}

/** The filesystem's own calls, through its promises. */
export const diskRemovalCalls: TreeRemovalCalls = {
	lstat: (path) => promises.lstat(path),
	chmod: (path, mode) => promises.chmod(path, mode),
	entries: (dir) => promises.readdir(dir, { withFileTypes: true }),
	rmdir: (path) => promises.rmdir(path),
	unlink: (path) => promises.unlink(path),
};

/**
 * Remove `path` and everything under it, one filesystem call at a time.
 *
 * A host shares its thread with every conversation, and its thread pool
 * too: removed in one go, a workspace of builds held a host's thread for
 * 7 s on 19 Nov, and node's own recursive removal fans out onto the four
 * threads every conversation's reads and writes wait on. A link is
 * removed, never followed, and each folder is made writable by its
 * owner first, since Go's module cache makes its folders read-only.
 * What something else removed meanwhile counts as gone.
 */
export async function removeTree(
	path: string,
	calls: TreeRemovalCalls = diskRemovalCalls,
): Promise<void> {
	const found = await unlessGone(calls.lstat(path));
	if (found === undefined) return;
	if (found.isDirectory()) await removeFolder(path, calls);
	else await unlessGone(calls.unlink(path));
}

/** A folder, its contents first, as `removeTree` takes it. */
async function removeFolder(
	dir: string,
	calls: TreeRemovalCalls,
): Promise<void> {
	const writable = calls.chmod(dir, 0o700).then(() => true);
	if ((await unlessGone(writable)) === undefined) return;
	const entries = await unlessGone(calls.entries(dir));
	for (const entry of entries ?? []) {
		const path = join(dir, entry.name);
		// A link to a folder is no folder here, so its target is spared.
		if (entry.isDirectory()) await removeFolder(path, calls);
		else await unlessGone(calls.unlink(path));
	}
	await unlessGone(calls.rmdir(dir));
}

/** What a call gave, or nothing if what it acts on is already gone. */
async function unlessGone<T>(call: Promise<T>): Promise<T | undefined> {
	try {
		return await call;
	} catch (error) {
		if (error instanceof Error && Reflect.get(error, "code") === "ENOENT")
			return undefined;
		throw error;
	}
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

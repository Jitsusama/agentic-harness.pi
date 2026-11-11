/**
 * Where the work broker writes down each tree it cut, with the sessions
 * holding it, so the next session finds it (lib/core/work/memory.ts).
 *
 * Beside the trees rather than inside one: a file written into a worktree
 * shows up as an untracked change in somebody's status, and `status`
 * refusing to repoint over uncommitted work would then be refusing over
 * our own bookkeeping.
 *
 * In the library rather than the work extension because more than it
 * reads them: a session carrying its work to another machine, and
 * `pi-carry` for the sessions no pi runs, carry the trees these name.
 */

import { realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { createTreeMemory } from "../core/work/memory.ts";
import { stateDir } from "./paths.ts";

/** The folder of the work broker's records of the trees it cut. */
export function treeRecordDir(): string {
	return join(stateDir("work"), "cut");
}

/** The folder the work broker cuts its trees in. */
export function cutTreeDir(): string {
	return join(stateDir("work"), "trees");
}

/** A tree the broker cut, still on disk, and the sessions its record names. */
export interface RecordedTree {
	readonly path: string;
	readonly sessions: readonly string[];
}

/** Every tree the records in `dir` name that is still on disk. */
export function recordedTrees(dir: string = treeRecordDir()): RecordedTree[] {
	return createTreeMemory(dir)
		.recall()
		.map((tree) => ({
			path: tree.path,
			sessions: Array.isArray(tree.sessions)
				? tree.sessions.filter((one): one is string => typeof one === "string")
				: [],
		}));
}

/** A path as the disk names it, links followed, where it can be. */
function canonical(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		// A path that isn't there is compared as written.
		return resolve(path);
	}
}

/**
 * Whether `folder` is, or lies inside, a tree the work broker cut: one an
 * agent made for its own work. Joel ruled on 8 November that such trees
 * are trusted by default, so pi's folder-trust prompt never stops a
 * session started in one.
 */
export function isAgentCut(
	folder: string,
	dir: string = treeRecordDir(),
): boolean {
	const here = canonical(folder);
	return recordedTrees(dir).some((tree) => {
		const root = canonical(tree.path);
		return here === root || here.startsWith(`${root}${sep}`);
	});
}

/** The folders of the trees the records in `dir` name as held by `session`. */
export function treesHeldBy(
	session: string,
	dir: string = treeRecordDir(),
): string[] {
	return recordedTrees(dir)
		.filter((tree) => tree.sessions.includes(session))
		.map((tree) => tree.path);
}

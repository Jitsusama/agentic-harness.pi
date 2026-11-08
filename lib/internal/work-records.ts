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

import { join } from "node:path";
import { createTreeMemory } from "../core/work/memory.ts";
import { stateDir } from "./paths.ts";

/** The folder of the work broker's records of the trees it cut. */
export function treeRecordDir(): string {
	return join(stateDir("work"), "cut");
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

/** The folders of the trees the records in `dir` name as held by `session`. */
export function treesHeldBy(
	session: string,
	dir: string = treeRecordDir(),
): string[] {
	return recordedTrees(dir)
		.filter((tree) => tree.sessions.includes(session))
		.map((tree) => tree.path);
}

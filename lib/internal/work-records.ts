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

import { existsSync, realpathSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { createTreeMemory } from "../core/work/memory.ts";
import { readStamped, type Stamped } from "./files/stamped-read.ts";
import { stateDir } from "./paths.ts";
import { processGlobal } from "./process/process-global.ts";

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

/** The records as last read, and when each tree's folder was last seen. */
interface Listing {
	trees: readonly RecordedTree[];
	judgedAt: number;
	/** Read so soon after the folder's last write that a later one may share its stamp. */
	readonly racy: boolean;
}

/**
 * How long a listing's trees are taken to be on disk without looking: a
 * tree removed by hand with its record left moves no stamp, so it is
 * looked for again this often.
 */
const JUDGED_FOR_MS = 60_000;

/**
 * How soon after its folder's last write a listing isn't kept. A file's
 * time comes from a coarse clock, and a folder's size need not move when
 * an entry is replaced, so a write in the tick a listing was read in can
 * leave the stamp as it was. Git calls such an index entry racily clean,
 * and checks it again. As long as the quest documents' rule
 * (lib/internal/quest/documents/parsed-file.ts), for filesystems whose
 * tick is coarser still; a listing read within it costs one more read.
 */
const RACY_MS = 3_000;

// The records each folder held when it was last read, for the whole
// process and every copy of this module: every session in a host asks
// at each presence publish and each fenced command, and the records are
// the same for all of them, so one cut costs one read of them, not one
// for each session. The key names the shape; a change to Listing takes
// a new one.
const listings = processGlobal(
	"agentic-harness.internal/work-records/listings.v1",
	() => new Map<string, Stamped<Listing>>(),
);

/** Every record in `dir`, read with the trees still on disk. */
function readListing(dir: string): Listing {
	// Judged from before the read: a write landing while a slow read runs
	// can share the stamp the read was keyed by.
	const started = Date.now();
	const written = writtenAt(dir);
	const trees = createTreeMemory(dir)
		.recall()
		.map((tree) => ({
			path: tree.path,
			sessions: Array.isArray(tree.sessions)
				? tree.sessions.filter((one): one is string => typeof one === "string")
				: [],
		}));
	const racy = written === undefined || started - written < RACY_MS;
	return { trees, judgedAt: Date.now(), racy };
}

/** When `dir` was last written, if it is there. */
function writtenAt(dir: string): number | undefined {
	try {
		return statSync(dir).mtimeMs;
	} catch {
		// Gone since its stamp was taken: a listing of it isn't kept.
		return undefined;
	}
}

/**
 * Every tree the records in `dir` name that is still on disk. Read once
 * for the process while the folder's stamp holds: each record is written
 * beside it and renamed in, so a write moves the stamp, unless it falls
 * in the tick the listing was read in, which is why a listing read just
 * after a write isn't kept. A record edited in place, as the broker never
 * writes one, moves no stamp and isn't seen until the next write. Trees
 * are looked for again once the listing is a minute old. Callers keep no
 * listing of their own: this one is already kept, and its rules are here.
 */
export function recordedTrees(dir: string = treeRecordDir()): RecordedTree[] {
	const listing = readStamped(listings, dir, readListing);
	if (!listing) return [];
	// Read again by the next caller, once its folder's time has moved on.
	if (listing.racy) listings.delete(dir);
	if (Date.now() - listing.judgedAt > JUDGED_FOR_MS) {
		listing.trees = listing.trees.filter((tree) => existsSync(tree.path));
		listing.judgedAt = Date.now();
	}
	return [...listing.trees];
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

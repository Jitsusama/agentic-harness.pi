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

import { realpathSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { HeldTree } from "../core/work/broker.ts";
import {
	createTreeMemory,
	recallOff,
	recordWritesRead,
	recordWritesSince,
	recordWritesSoFar,
	standingOff,
} from "../core/work/memory.ts";
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

/** The records as one reading found them. */
interface Listing {
	readonly trees: readonly RecordedTree[];
	/** The folder's stamp, taken before the reading. */
	readonly stamp: string;
	/** This process's record writes the reading holds, counted. */
	readonly through: number;
	/** When the trees were last looked for on disk. */
	readonly judgedAt: number;
	/**
	 * When a listing read so soon after its folder's last write that a
	 * later write may share its stamp is read once more; none for one
	 * read long enough after.
	 */
	readonly recheckAt?: number;
}

/** A folder's listing as last read, and the reading bringing it up to date. */
interface Kept {
	listing: Listing;
	/** The reading off the thread under way, while one is. */
	refreshing: Promise<void> | undefined;
	/** The folder's stamp when a reading last failed, until one succeeds. */
	failedAt: string | undefined;
}

/** A folder's stamp, and when it was last written. */
interface Folder {
	readonly stamp: string;
	readonly writtenAt: number;
}

/**
 * How long a listing's trees are taken to be on disk without looking: a
 * tree removed by hand with its record left moves no stamp, so it is
 * looked for again this often.
 */
const JUDGED_FOR_MS = 60_000;

/**
 * How soon after its folder's last write a listing is read once more. A
 * file's time comes from a coarse clock, and a folder's size need not
 * move when an entry is replaced, so a write in the tick a listing was
 * read in can leave the stamp as it was. Git calls such an index entry
 * racily clean, and checks it again. As long as the quest documents'
 * rule (lib/internal/quest/documents/parsed-file.ts), for filesystems
 * whose tick is coarser still. The listing is kept until then rather
 * than read at every call, so a burst of writes costs one more read for
 * the process, not one for each caller in the window; such a write is
 * seen at most this late.
 */
const RACY_MS = 3_000;

// The records each folder held when it was last read, for the whole
// process and every copy of this module: every session in a host asks
// at each presence publish and each fenced command, and the records are
// the same for all of them, so one cut costs one read of them, not one
// for each session, and that read runs off the thread. The key names
// the shape; a change to Kept or Listing takes a new one.
const listings = processGlobal(
	"agentic-harness.internal/work-records/listings.v2",
	() => new Map<string, Kept>(),
);

/** `dir`'s stamp, its inode, mtime and size, or none when it isn't there. */
function folderNow(dir: string): Folder | undefined {
	try {
		const seen = statSync(dir);
		return {
			stamp: `${seen.ino}:${seen.mtimeMs}:${seen.size}`,
			writtenAt: seen.mtimeMs,
		};
	} catch {
		// No folder: no records, and no listing of it kept.
		return undefined;
	}
}

/**
 * A record as callers are handed it, frozen: every session in the
 * process is handed these, and the fence grants writes from them.
 */
function recordedOf(tree: HeldTree): RecordedTree {
	return Object.freeze({
		path: tree.path,
		sessions: Object.freeze(
			Array.isArray(tree.sessions)
				? tree.sessions.filter((one): one is string => typeof one === "string")
				: [],
		),
	});
}

/**
 * The listing `trees` make, read from `folder` after `started` and
 * holding this process's writes up to `through`. Judged from before the
 * read: a write landing while a slow read runs can share the stamp the
 * read was keyed by.
 */
function listingOf(
	trees: readonly HeldTree[],
	folder: Folder,
	through: number,
	started: number,
): Listing {
	const listing = {
		trees: trees.map(recordedOf),
		stamp: folder.stamp,
		through,
		judgedAt: Date.now(),
	};
	return started - folder.writtenAt < RACY_MS
		? { ...listing, recheckAt: folder.writtenAt + RACY_MS }
		: listing;
}

/** Every record in `folder` at `dir`, read off the thread. */
async function readOff(dir: string, folder: Folder): Promise<Listing> {
	const started = Date.now();
	const through = recordWritesSoFar();
	return listingOf(await recallOff(dir), folder, through, started);
}

/** `listing` with the trees gone from the disk dropped, looked for off the thread. */
async function judgedOff(listing: Listing): Promise<Listing> {
	const stands = await standingOff(listing.trees.map((tree) => tree.path));
	return {
		...listing,
		trees: listing.trees.filter((_, at) => stands[at]),
		judgedAt: Date.now(),
	};
}

/**
 * `kept`'s reading `reading` of `dir`, swapped in once it lands; one
 * that fails leaves the listing as it was and marks `stamp`, so the
 * folder as it failed isn't read again until it changes.
 */
function settle(
	dir: string,
	kept: Kept,
	stamp: string,
	reading: Promise<Listing>,
): Promise<void> {
	return reading
		.then(
			(listing) => {
				// Forgotten since, its folder gone: nothing to swap into.
				if (listings.get(dir) !== kept) return;
				kept.listing = listing;
				kept.failedAt = undefined;
				recordWritesRead(dir, listing.through);
			},
			() => {
				kept.failedAt = stamp;
			},
		)
		.finally(() => {
			kept.refreshing = undefined;
		});
}

/**
 * Start a reading of `dir` off the thread when `kept`'s listing is out
 * of date: its folder changed, it was read too soon after a write, or
 * its trees weren't looked for in a minute. One at a time for the
 * process, and none while the folder stands as a reading failed on.
 */
function refreshIfDue(dir: string, kept: Kept, folder: Folder): void {
	if (kept.refreshing !== undefined || folder.stamp === kept.failedAt) return;
	const { listing } = kept;
	const now = Date.now();
	if (
		folder.stamp !== listing.stamp ||
		(listing.recheckAt !== undefined && now >= listing.recheckAt)
	) {
		kept.refreshing = settle(dir, kept, folder.stamp, readOff(dir, folder));
	} else if (now - listing.judgedAt > JUDGED_FOR_MS) {
		kept.refreshing = settle(dir, kept, folder.stamp, judgedOff(listing));
	}
}

/**
 * `listing` with this process's own writes since its reading laid over
 * it, so a tree a session cut shows to it at once, and one it forgot is
 * gone at once, whatever a reading started before them found.
 */
function laidOver(dir: string, listing: Listing): RecordedTree[] {
	const ours = recordWritesSince(dir, listing.through);
	if (ours.size === 0) return [...listing.trees];
	const trees = listing.trees.filter((tree) => !ours.has(tree.path));
	for (const write of ours.values()) {
		if (write.held !== undefined) trees.push(recordedOf(write.held));
	}
	return trees;
}

/**
 * Every tree the records in `dir` name that is still on disk, as last
 * read for the process. The first call in a process reads them on the
 * thread, since there is nothing yet to answer from. After that a call
 * answers from the last listing, and when the folder's stamp has moved
 * starts one reading off the thread, which later calls answer from once
 * it lands: another process's cut is seen a read late. A tree this
 * process cut or forgot is laid over the listing at once. Each record is
 * written beside the folder and renamed in, so a write moves the stamp,
 * unless it falls in the tick the listing was read in, which is why a
 * listing read just after a write is read once more when that write is
 * old enough. A record edited in place, as the broker never writes one,
 * moves no stamp and isn't seen until the next write. Trees are looked
 * for again, off the thread, once the listing is a minute old. Callers
 * keep no listing of their own: this one is already kept, and its rules
 * are here.
 */
export function recordedTrees(dir: string = treeRecordDir()): RecordedTree[] {
	const folder = folderNow(dir);
	if (folder === undefined) {
		listings.delete(dir);
		return [];
	}
	let kept = listings.get(dir);
	if (kept === undefined) {
		const started = Date.now();
		const through = recordWritesSoFar();
		const trees = createTreeMemory(dir).recall();
		kept = {
			listing: listingOf(trees, folder, through, started),
			refreshing: undefined,
			failedAt: undefined,
		};
		listings.set(dir, kept);
		recordWritesRead(dir, through);
	} else {
		refreshIfDue(dir, kept, folder);
	}
	return laidOver(dir, kept.listing);
}

/**
 * Settles once the reading of `dir` under way, if one is, has landed or
 * failed: for a caller, or a test, that needs another process's write
 * seen before it asks again.
 */
export function whenRefreshed(dir: string = treeRecordDir()): Promise<void> {
	return listings.get(dir)?.refreshing ?? Promise.resolve();
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
 * session started in one. Answered from the kept listing, so a tree
 * another process cut is seen about one read late; one this process cut
 * is seen at once.
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

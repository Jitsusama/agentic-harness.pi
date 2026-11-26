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
	holdRecordWrites,
	recallOff,
	recordDirKey,
	recordWritesRead,
	recordWritesSince,
	recordWritesSoFar,
	standingOff,
} from "../core/work/memory.ts";
import { isGone, isPassingFault } from "./files/errno.ts";
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

/** A folder's listing as last read, and how its last reading went. */
interface Kept {
	listing: Listing;
	/** The reading the listing came from, counted; 0 for the first, on the thread. */
	read: number;
	/**
	 * The folder's stamp, and when, as a reading last failed, until one
	 * succeeds; and, as for a listing, when a failure so soon after the
	 * folder's last write that a later write may share its stamp is tried
	 * once more.
	 */
	failed:
		| {
				readonly stamp: string;
				readonly at: number;
				readonly recheckAt?: number;
		  }
		| undefined;
}

/**
 * A reading off the thread under way: of the records, or only a look
 * for their trees on disk. It settles true once what it read is in.
 */
interface Reading {
	readonly done: Promise<boolean>;
	readonly since: number;
	readonly count: number;
}

/** A folder's stamp, and when it was last written. */
interface Folder {
	readonly stamp: string;
	readonly writtenAt: number;
}

/**
 * How long a listing's trees are taken to be on disk without looking: a
 * tree removed by hand with its record left moves no stamp, so it is
 * looked for again this often. A folder a reading failed on is read
 * again this long after, though its stamp stands as it failed.
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

/**
 * How long a reading may run before it is let go and another started:
 * a disk that hangs one read, a network mount gone away, would
 * otherwise hold the listing where it was for the life of the process.
 * Far past any reading seen; the slowest of 1,169 files ran in seconds.
 */
const HUNG_AFTER_MS = 5 * 60_000;

/** How long a caller that asks once waits for its reading by default. */
const ASKED_ONCE_WITHIN_MS = 60_000;

// The records each folder held when it was last read, for the whole
// process and every copy of this module: every session in a host asks
// at each presence publish and each fenced command, and the records are
// the same for all of them, so one cut costs one read of them, not one
// for each session, and that read runs off the thread. Kept under the
// folder as the disk names it (recordDirKey), so callers spelling it
// two ways share one listing. The key names the shape; a change to
// Kept or Listing takes a new one.
const listings = processGlobal(
	"agentic-harness.internal/work-records/listings.v4",
	() => new Map<string, Kept>(),
);

// The reading under way of each folder, apart from its listing: a
// folder gone and made again gets a listing afresh, and a reading begun
// before it went must still count as the one under way, or two would
// run at once. Counted for the process, so a later reading always
// outranks an earlier one, whichever lands last.
const readings = processGlobal(
	"agentic-harness.internal/work-records/readings.v1",
	() => ({ under: new Map<string, Reading>(), begun: 0 }),
);

// The first reading of each folder begun off the thread, for a caller
// that answers without the records until it lands (`keptTreesHeldBy`),
// and when it began, so one that hangs is let go as a reading is.
const firsts = processGlobal(
	"agentic-harness.internal/work-records/firsts.v1",
	() =>
		new Map<string, { readonly done: Promise<void>; readonly since: number }>(),
);

// What has been said on stderr of each folder, so a host's journal
// hears of a folder going unseen, a reading failing at a stamp or a
// reading hanging once, not at every call while it lasts.
const told = processGlobal(
	"agentic-harness.internal/work-records/told.v1",
	() => new Map<string, Set<string>>(),
);

/** Say `text` on stderr, a host's journal, once for `what` of the folder at `at`. */
function tell(at: string, what: string, text: string): void {
	let said = told.get(at);
	if (said === undefined) {
		said = new Set();
		told.set(at, said);
	}
	if (said.has(what)) return;
	said.add(what);
	process.stderr.write(`[work] ${text}\n`);
}

/** Let what the folder at `at` was told of, as `over` says, be told again. */
function untell(at: string, over: (what: string) => boolean): void {
	const said = told.get(at);
	if (said === undefined) return;
	for (const what of said) if (over(what)) said.delete(what);
}

/** Why a failure failed, in words. */
function whyOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * `dir`'s stamp, its inode, mtime and size; gone when it isn't there,
 * and unseen when it can't be looked at for now.
 */
function folderNow(dir: string): Folder | "gone" | "unseen" {
	try {
		const seen = statSync(dir);
		return {
			stamp: `${seen.ino}:${seen.mtimeMs}:${seen.size}`,
			writtenAt: seen.mtimeMs,
		};
	} catch (error) {
		return isGone(error) ? "gone" : "unseen";
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
	return {
		trees: trees.map(recordedOf),
		stamp: folder.stamp,
		through,
		judgedAt: Date.now(),
		...racyOf(folder, started),
	};
}

/**
 * When what was read of `folder` from `started` is read once more, for
 * a read so soon after its last write that a later write may share its
 * stamp; nothing for one read long enough after.
 */
function racyOf(folder: Folder, started: number): { recheckAt?: number } {
	return started - folder.writtenAt < RACY_MS
		? { recheckAt: folder.writtenAt + RACY_MS }
		: {};
}

/**
 * The first reading of `dir` in the process, on the thread, since there
 * is nothing yet to answer from; kept once it reads. One that fails
 * throws, keeping nothing.
 */
function readFirst(dir: string, folder: Folder): Kept {
	const started = Date.now();
	const through = recordWritesSoFar();
	const trees = createTreeMemory(dir).recall();
	const kept: Kept = {
		listing: listingOf(trees, folder, through, started),
		read: 0,
		failed: undefined,
	};
	const at = recordDirKey(dir);
	listings.set(at, kept);
	recordWritesRead(dir, through);
	untell(at, (what) => what === "first reading failed");
	return kept;
}

/** Every record in `folder` at `dir`, read off the thread from `started`. */
async function readOff(
	dir: string,
	folder: Folder,
	started: number,
): Promise<Listing> {
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

/** Whether `kept` is still the listing of `dir`, not forgotten since. */
function stillKept(dir: string, kept: Kept): boolean {
	return listings.get(recordDirKey(dir)) === kept;
}

/**
 * `listing`, which looked for the trees of `kept`'s listing `of`, swapped
 * in, unless a reading has swapped in a newer listing since.
 */
function swapJudged(dir: string, kept: Kept, of: Listing, listing: Listing) {
	if (stillKept(dir, kept) && kept.listing === of) kept.listing = listing;
}

/**
 * Reading `count` of `dir`, which read `listing`, swapped into `kept`
 * unless the folder was forgotten since or a later reading is in: a
 * reading let go as hung may land after the one begun in its place.
 * Only a reading clears a failure, since only a reading read the folder.
 */
function swapRead(dir: string, kept: Kept, count: number, listing: Listing) {
	if (!stillKept(dir, kept) || count < kept.read) return;
	kept.listing = listing;
	kept.read = count;
	kept.failed = undefined;
	recordWritesRead(dir, listing.through);
	// What failed or hung before is told again should it happen again, and
	// the folder's told set stays as small as what is wrong with it now.
	untell(
		recordDirKey(dir),
		(what) => what.startsWith("failed at ") || what.startsWith("hung "),
	);
}

/**
 * Reading `count` of `dir`, begun at `started`, failed at `folder`'s
 * stamp: the listing stays as it was, and the stamp is marked, so the
 * folder as it failed is read again only once it changes, a minute on,
 * or, failing so soon after a write that a later one may share the
 * stamp, once that write is old enough, as a listing would be; and it
 * is said once. Its trees are still looked for on disk once the
 * listing is a minute old.
 */
async function readingFailed(
	dir: string,
	kept: Kept,
	count: number,
	folder: Folder,
	started: number,
	error: unknown,
): Promise<void> {
	if (!stillKept(dir, kept) || count < kept.read) return;
	tell(
		recordDirKey(dir),
		`failed at ${folder.stamp}`,
		`the tree records in ${dir} couldn't be read off the thread; answering from the reading before, and reading again within a minute: ${whyOf(error)}`,
	);
	kept.failed = {
		stamp: folder.stamp,
		at: Date.now(),
		...racyOf(folder, started),
	};
	if (Date.now() - kept.listing.judgedAt <= JUDGED_FOR_MS) return;
	const of = kept.listing;
	swapJudged(dir, kept, of, await judgedOff(of));
}

/**
 * Begin reading `dir` off the thread, the records or, `judging`, only a
 * look for the trees of `kept`'s listing, as the reading under way.
 */
function begin(
	dir: string,
	kept: Kept,
	folder: Folder,
	kind: "reading" | "judging",
): Reading {
	const at = recordDirKey(dir);
	readings.begun += 1;
	const count = readings.begun;
	const of = kept.listing;
	const started = Date.now();
	const settled =
		kind === "reading"
			? readOff(dir, folder, started).then(
					(listing) => {
						swapRead(dir, kept, count, listing);
						return true;
					},
					async (error: unknown) => {
						await readingFailed(dir, kept, count, folder, started, error);
						return false;
					},
				)
			: judgedOff(of).then(
					(listing) => {
						swapJudged(dir, kept, of, listing);
						return true;
					},
					// A look that fails leaves the listing to the next look.
					() => false,
				);
	const done = settled
		.catch(() => false)
		.finally(() => {
			if (readings.under.get(at)?.count === count) readings.under.delete(at);
		});
	const reading = { done, since: Date.now(), count };
	readings.under.set(at, reading);
	return reading;
}

/**
 * The reading of `dir` under way, unless it has run so long it is let
 * go, which is said once.
 */
function underWay(dir: string): Reading | undefined {
	const at = recordDirKey(dir);
	const under = readings.under.get(at);
	if (under === undefined || Date.now() - under.since <= HUNG_AFTER_MS) {
		return under;
	}
	tell(
		at,
		`hung ${under.count}`,
		`a reading of the tree records in ${dir} ran past ${HUNG_AFTER_MS / 60_000} minutes; letting it go and reading again`,
	);
	readings.under.delete(at);
	return undefined;
}

/** Whether `listing` no longer answers for `folder`: changed, or read too soon. */
function outOfDate(listing: Listing, folder: Folder): boolean {
	return (
		folder.stamp !== listing.stamp ||
		(listing.recheckAt !== undefined && Date.now() >= listing.recheckAt)
	);
}

/**
 * Start a reading of `dir` off the thread when `kept`'s listing is out
 * of date: its folder changed, it was read too soon after a write, or
 * its trees weren't looked for in a minute. One at a time for the
 * process. A folder standing as a reading failed on is read again only
 * a minute on, its trees looked for meanwhile.
 */
function refreshIfDue(dir: string, kept: Kept, folder: Folder): void {
	if (underWay(dir) !== undefined) return;
	const { listing, failed } = kept;
	const waiting =
		failed !== undefined &&
		failed.stamp === folder.stamp &&
		Date.now() - failed.at <= JUDGED_FOR_MS &&
		!(failed.recheckAt !== undefined && Date.now() >= failed.recheckAt);
	if (outOfDate(listing, folder) && !waiting) {
		begin(dir, kept, folder, "reading");
	} else if (Date.now() - listing.judgedAt > JUDGED_FOR_MS) {
		begin(dir, kept, folder, "judging");
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
 * thread, since there is nothing yet to answer from; one the disk fails
 * for now, out of descriptors, answers none, says so, and keeps nothing,
 * so the next call reads again. After that a call answers from the last
 * listing, and when the folder's stamp has moved starts one reading off
 * the thread, which later calls answer from once it lands: another
 * process's cut or release is seen a read late. A tree this process cut
 * or forgot is laid over the listing at once. Each record is written
 * beside the folder and renamed in, so a write moves the stamp, unless
 * it falls in the tick the listing was read in, which is why a listing
 * read just after a write is read once more when that write is old
 * enough. A record edited in place, as the broker never writes one,
 * moves no stamp and isn't seen until the next write. Trees are looked
 * for again, off the thread, once the listing is a minute old. A folder
 * that can't be looked at for now answers none, as before any listing
 * was kept, since nothing shows whether it still holds the trees kept;
 * it is said once, and once it can be looked at the kept listing
 * answers again. Only writes through createTreeMemory are this
 * process's own: a record written by hand, or by a conversation still
 * running code from before this listing, is seen a read late like
 * another process's. Callers keep no listing of their own: this one is
 * already kept, and its rules are here; one that asks once and acts on
 * the answer asks `treesHeldByNow`.
 */
export function recordedTrees(dir: string = treeRecordDir()): RecordedTree[] {
	const folder = folderNow(dir);
	const at = recordDirKey(dir);
	if (folder === "gone") {
		listings.delete(at);
		told.delete(at);
		return [];
	}
	if (folder === "unseen") {
		tell(
			at,
			"unseen",
			`the tree records in ${dir} can't be looked at; granting no tree they name until they can`,
		);
		return [];
	}
	untell(at, (what) => what === "unseen");
	let kept = listings.get(at);
	if (kept === undefined) {
		try {
			kept = readFirst(dir, folder);
		} catch (error) {
			if (!isPassingFault(error)) throw error;
			tell(
				at,
				"first reading failed",
				`the tree records in ${dir} couldn't be read; granting no tree they name until they can: ${whyOf(error)}`,
			);
			return [];
		}
	} else {
		refreshIfDue(dir, kept, folder);
	}
	return laidOver(dir, kept.listing);
}

/**
 * Settles once the reading of `dir` under way, if one is, has landed or
 * failed, the first one off the thread included: for a caller, or a
 * test, that needs another process's write seen before it asks again.
 */
export async function whenRefreshed(
	dir: string = treeRecordDir(),
): Promise<void> {
	await firsts.get(recordDirKey(dir))?.done;
	await readings.under.get(recordDirKey(dir))?.done;
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
 * another process cut, or let go, is seen one reading late; one this
 * process cut is seen at once. For a fence asking at every command that
 * costs at most a command refused, or granted, once more and a retry:
 * reading the folder again on the thread at each command would stall
 * every session in a host while it ran.
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

/**
 * The folders of the trees the records in `dir` name as held by
 * `session`, from the kept listing: another process's cut or release is
 * seen one reading late, as `isAgentCut` says why.
 */
export function treesHeldBy(
	session: string,
	dir: string = treeRecordDir(),
): string[] {
	return heldIn(recordedTrees(dir), session);
}

/**
 * `treesHeldBy`, for a caller that can answer without it for now: never
 * read on the thread. Before the process has a listing of `dir` it
 * begins the first reading off the thread and answers nothing
 * (`undefined`); once that lands it answers as `treesHeldBy` does. A
 * presence asks at every publish, and its first, as a session starts,
 * read 3,278 records on the thread for 52.8 s of one child's start on
 * 26 November, while the disk was full; it says the trees it last said
 * until this answers. A folder gone or out of reach answers as
 * `treesHeldBy` does, which reads nothing.
 */
export function keptTreesHeldBy(
	session: string,
	dir: string = treeRecordDir(),
): string[] | undefined {
	const folder = folderNow(dir);
	if (typeof folder === "string" || listings.has(recordDirKey(dir))) {
		return treesHeldBy(session, dir);
	}
	readFirstOff(dir, folder);
	return undefined;
}

/**
 * Begin the first reading of `dir` off the thread, unless one is under
 * way and not yet hung, keeping what it reads as the listing unless a
 * reading on the thread kept one first. One that fails keeps nothing,
 * says so once, and is begun again at the next ask.
 */
function readFirstOff(dir: string, folder: Folder): void {
	const at = recordDirKey(dir);
	const under = firsts.get(at);
	if (under !== undefined && Date.now() - under.since <= HUNG_AFTER_MS) return;
	if (under !== undefined) {
		tell(
			at,
			"first reading hung",
			`the first reading of the tree records in ${dir} ran past ${HUNG_AFTER_MS} ms, so another is begun beside it`,
		);
	}
	const started = Date.now();
	const done = readOff(dir, folder, started).then(
		(listing) => {
			if (listings.has(at)) return;
			listings.set(at, { listing, read: 0, failed: undefined });
			recordWritesRead(dir, listing.through);
			untell(
				at,
				(what) =>
					what === "first reading failed" || what === "first reading hung",
			);
		},
		(error: unknown) => {
			tell(
				at,
				"first reading failed",
				`the tree records in ${dir} couldn't be read off the thread; reading again at the next ask: ${whyOf(error)}`,
			);
		},
	);
	const first = {
		done: done.finally(() => {
			if (firsts.get(at) === first) firsts.delete(at);
		}),
		since: started,
	};
	firsts.set(at, first);
}

/** The folders of `trees` that `session` holds. */
function heldIn(trees: readonly RecordedTree[], session: string): string[] {
	return trees
		.filter((tree) => tree.sessions.includes(session))
		.map((tree) => tree.path);
}

/**
 * `treesHeldBy`, read afresh off the thread: for a caller that asks once
 * and acts on the answer, such as a carry, which a tree cut a read ago
 * by another process would otherwise be left out of. A kept listing
 * the folder hasn't moved past answers at once; otherwise its reading
 * is its own, begun after it was asked, so it never waits on the shared one,
 * which a busy machine's writes keep starting again, and it looks on
 * disk only for the trees `session` holds, not for every tree the
 * records name: with thousands of them, a look for each, through a
 * host's few threads under load, ran past a minute (A210E4CA, 25
 * November). This process's own writes since are laid over it, as the
 * kept listing's are, and held while it reads, so a shared reading
 * landing meanwhile can't let go of one it never saw. It refuses, throwing, rather than answer from a
 * reading it can't vouch for: when the folder can't be looked at, when
 * the reading fails, and when it doesn't land within `within`
 * milliseconds. A reading that ran late runs on to its end, so until
 * then a second ask for the same session refuses at once rather than
 * start another beside it: a carry asked again on a pool too busy to
 * answer would otherwise stack a reading on it at every try.
 */
export async function treesHeldByNow(
	session: string,
	dir: string = treeRecordDir(),
	within: number = ASKED_ONCE_WITHIN_MS,
): Promise<string[]> {
	const key = `${recordDirKey(dir)}\0${session}`;
	if (readingsNow.has(key)) {
		throw new Error(
			`the tree records in ${dir} are still being read from an earlier ask that ran late`,
		);
	}
	const reading = readNow(session, dir);
	readingsNow.add(key);
	reading
		.finally(() => readingsNow.delete(key))
		.catch(() => {
			// The race below says why it failed; this only lets the key go.
		});
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<never>((_, refuse) => {
		timer = setTimeout(
			() =>
				refuse(
					new Error(`the tree records in ${dir} weren't read in ${within} ms`),
				),
			within,
		);
	});
	try {
		return await Promise.race([reading, late]);
	} finally {
		clearTimeout(timer);
	}
}

/** The folders and sessions a `treesHeldByNow` reading runs for now. */
const readingsNow = new Set<string>();

/** `treesHeldByNow`'s answer, however long its reading takes. */
async function readNow(session: string, dir: string): Promise<string[]> {
	const folder = folderNow(dir);
	if (folder === "gone") return [];
	if (folder === "unseen") {
		throw new Error(`the tree records in ${dir} can't be looked at`);
	}
	// A kept listing the folder hasn't moved past, read late enough after
	// the last write that none can share its stamp, is as fresh as a new one.
	const known = listings.get(recordDirKey(dir));
	if (
		known !== undefined &&
		!outOfDate(known.listing, folder) &&
		known.listing.recheckAt === undefined
	) {
		return heldIn(laidOver(dir, known.listing), session);
	}
	const started = Date.now();
	const through = recordWritesSoFar();
	const letGo = holdRecordWrites(dir, through);
	try {
		const trees = await recallOff(
			dir,
			(held) => Array.isArray(held.sessions) && held.sessions.includes(session),
		);
		const listing = listingOf(trees, folder, through, started);
		return heldIn(laidOver(dir, listing), session);
	} catch (error) {
		throw new Error(
			`the tree records in ${dir} couldn't be read: ${whyOf(error)}`,
		);
	} finally {
		letGo();
	}
}

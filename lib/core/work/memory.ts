/**
 * Remembering the trees a session cut, so the next session can find them.
 *
 * The broker held its trees in an array, which is correct for exactly as long as
 * the process lives. A worktree outlives the process by design, so the next
 * session opened with the trees still on disk, git still tracking them, and
 * every verb answering "no held tree": not merely a listing that forgot, but
 * commits stranded in a directory the tool could no longer reach, releasable
 * only through the `git worktree` call the guide tells you never to make.
 *
 * No test could see it. A test builds a broker and uses it, which is one
 * process; the fault needs two.
 *
 * The directory stays the source of truth for whether a tree exists, and this
 * only supplies the identity a directory name cannot faithfully carry. When the
 * two disagree the directory wins, because somebody who deletes a tree by hand
 * has said something and a stale record has not.
 *
 * A record also says who cut it, which is a later addition and the reason
 * anything is ever reclaimed. Without it "remembered" and "held" were one set,
 * so every tree ever cut answered "something still holds it" forever: measured
 * at 59 records and 649MB on one machine, growing by a snapshot per review
 * round.
 *
 * Long because the records are read two ways, on the thread for a first
 * answer and off it for a host whose conversations share one loop, and both
 * readers parse one record format and judge it by the same rules: a change to
 * what a record holds, or to who still holds it, is a change to both.
 */

import { randomBytes } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isGone, isPassingFault } from "../../internal/files/errno.ts";
import { processGlobal } from "../../internal/process/process-global.ts";
import {
	askedOnceWithTicks,
	tickedStanding,
	tickFacts,
} from "../../internal/process-ticks.ts";
import { withFileLock } from "../internal/file-lock.ts";
import {
	isOwner,
	type Owner,
	ownerNow,
	type ProcessFacts,
	sameProcess,
	systemFacts,
} from "../process/index.ts";
import { hosted, sessionOwner } from "../session/index.ts";
import type { HeldTree } from "./broker.ts";

/** Somewhere to write down what was cut. */
export interface TreeMemory {
	/** Write a tree down, so a later session can find it. */
	remember(held: HeldTree): void;
	/**
	 * Write a tree down as held by this session.
	 *
	 * Separate from `remember`, which stays exactly as literal as it was: a
	 * caller replaying a record, or a test constructing one, must be able to
	 * write what it means rather than have this process's identity stamped
	 * over it.
	 */
	rememberHeldByUs(held: HeldTree, facts?: ProcessFacts): Promise<void>;
	/** Forget one, once it has genuinely gone. */
	forget(path: string): void;
	/** Every tree written down that is still on disk. */
	recall(): readonly HeldTree[];
	/**
	 * Those a running session still holds.
	 *
	 * Distinct from `recall`, which must keep returning a dead session's
	 * trees: reusing the snapshot a finished round left behind is the point
	 * of a shareable tree, and it is what lets six reviewers of one commit
	 * share one directory. This is the narrower question tidy asks, and only
	 * tidy: whether taking the directory away would pull it out from under
	 * somebody.
	 */
	heldNow(facts?: ProcessFacts): Promise<readonly HeldTree[]>;
	/**
	 * Those whose record does not say who cut them.
	 *
	 * A subset of what `heldNow` returns, since an unattributable tree is
	 * counted as held: this names them so a caller can report them as the
	 * decision they are rather than as a claim somebody made.
	 */
	unattributed(): readonly HeldTree[];
	/**
	 * Who else is standing in this tree, this session excluded.
	 *
	 * Only holders still running count, since a dead one is not
	 * somebody a release has to be careful of. Empty for a tree nobody
	 * else holds and for one whose record names nobody, which is right
	 * for a release: the caller asked to take its own tree down, and
	 * only another live session is a reason not to.
	 */
	otherHolders(path: string, facts?: ProcessFacts): Promise<readonly Owner[]>;
	/**
	 * The paths of those trees whose records name this session as a
	 * holder, read from the trees as given rather than from disk, so a
	 * listing pays one identity probe however long it is. A session
	 * resumed after a restart is named again by `reownSession`, so its
	 * own trees are found here though this process cut none of them.
	 */
	heldByUs(
		trees: readonly HeldTree[],
		facts?: ProcessFacts,
	): Promise<ReadonlySet<string>>;
	/** Take this session off a tree's record, leaving the record. */
	forgetUsAsHolder(path: string, facts?: ProcessFacts): Promise<void>;
	/**
	 * Run `take` on a tree only while every session its record names has
	 * ended, and forget the record once `take` says the tree is out of
	 * the way.
	 *
	 * Judged again under the record's lock, the one a session taking the
	 * tree up writes its claim under, so a session that took it up since
	 * the caller looked is seen and the tree is left alone. That lock is
	 * held for milliseconds by everyone else and taken over at thirty
	 * seconds, so `take` must be quick: a move, never a removal. A record
	 * that names nobody is never taken, since nothing can say it is spent.
	 * Answers the record it forgot, so a caller whose next step fails can
	 * write it back, or nothing when `take` didn't run or didn't take it.
	 */
	whileUnheld(
		path: string,
		take: () => Promise<boolean>,
		facts?: ProcessFacts,
	): Promise<HeldTree | undefined>;
	/**
	 * Make this session a tree's only holder, but only while every session
	 * its record names has ended, judged under the record's lock as
	 * {@link whileUnheld} judges it.
	 *
	 * For a tree that can't be moved aside before it is removed: while
	 * the record names a running session, the broker hands the tree to
	 * nobody else, so a removal that takes minutes can run outside the
	 * lock. Never for a shareable tree, which another session may join
	 * whoever holds it. Answers the record as it was, so a caller whose
	 * removal fails can put it back, or nothing when the tree is held, or
	 * when the machine won't say when this session started.
	 */
	holdWhileUnheld(
		path: string,
		facts?: ProcessFacts,
	): Promise<HeldTree | undefined>;
	/**
	 * Run `take` on a tree whatever sessions hold it, but only while none
	 * has asked for it since `since`, in milliseconds since the epoch, and
	 * forget the record once `take` says the tree is out of the way.
	 *
	 * For a snapshot a live session pinned and left: judged under the
	 * record's lock, where a session asking for the tree writes its use,
	 * so one that asked since the caller looked is seen and the tree is
	 * left alone, and one asking after finds no record and cuts afresh.
	 * Its use is the later of its `usedAt` and when its record was last
	 * written (see {@link askedAt}), since code from before the dating
	 * carries a stale `usedAt` but rewrites the record on every ask.
	 * `take` must be quick, as for {@link whileUnheld}. Answers the record
	 * it forgot, or nothing when `take` didn't run or didn't take it.
	 * Given the tree's `key`, only its record's own file is read and
	 * removed, as for {@link askedAt}: listing every record three times a
	 * take, with a stat of every tree, cost a sweep taking hundreds of trees
	 * millions of reads in the folders Joel's windows wait on. A record
	 * written under another name then reads as none, which keeps its tree.
	 * Another record naming the same path is left: none names a git
	 * snapshot (the paths two records share are World's, under its two
	 * keys), and one would read as live again only were the path cut anew.
	 */
	whileUnusedSince(
		path: string,
		since: number,
		take: () => Promise<boolean>,
		key?: string,
	): Promise<HeldTree | undefined>;
	/**
	 * When the record of the tree at `path` was last written, in
	 * milliseconds since the epoch: every session's every ask rewrites
	 * it, on whatever code it runs. Nothing when there is no record, or
	 * its file can't be read. Given the tree's `key`, its record's own
	 * file is read and no other: a sweep dates every held snapshot, and
	 * listing every record for each read the folder hundreds of
	 * thousands of times on the host's thread. A record written under
	 * another name then reads as undated, which keeps its tree.
	 */
	askedAt(path: string, key?: string): number | undefined;
	/**
	 * Make `session` the holder of every tree a record says it holds, as
	 * the process it runs in now, and answer how many records changed.
	 *
	 * A session outlives its process: resumed after a restart, it runs in
	 * a new one while its records still name the old, which reads as
	 * ended to anything judging by owners. Each record with an owner
	 * naming this session drops the owners naming it and those whose
	 * process is gone, and gains this one, under the record's lock. A
	 * record already naming only live holders and this one is left as it
	 * is. Plain pi names no session on an owner, so only hosted records
	 * follow.
	 */
	reownSession(session: string, facts?: ProcessFacts): Promise<number>;
}

/** How many times a listing the directory changed under is read again. */
const LISTING_TRIES = 8;

/** How many records a reading off the thread reads at once. */
const READS_AT_ONCE = 16;

/** What changes about a directory when an entry in it does. */
function stamp(dir: string): string | undefined {
	try {
		return stampOf(statSync(dir, { bigint: true }));
	} catch {
		return undefined;
	}
}

/** `stamp`, read off the thread. */
async function stampOff(dir: string): Promise<string | undefined> {
	try {
		return stampOf(await stat(dir, { bigint: true }));
	} catch {
		return undefined;
	}
}

/** A directory's stamp from its stat. */
function stampOf(seen: {
	readonly ino: bigint;
	readonly mtimeNs: bigint;
	readonly ctimeNs: bigint;
}): string {
	return `${seen.ino}:${seen.mtimeNs}:${seen.ctimeNs}`;
}

/** A record this process wrote, or forgot when it holds none. */
export interface RecordWrite {
	/** Where it lands among this process's writes, counting from one. */
	readonly seq: number;
	readonly held?: HeldTree;
}

// The records this process wrote or forgot, by directory and then by
// tree, the latest for each, counted in the order they landed. A reader
// that keeps a listing and refreshes it off the thread lays these over
// whatever reading it swaps in, so a reading that started before a cut
// can't hide it from the session that made it (85PKB2, 21 November).
// Process-wide because the records are the machine's, and a reader in
// any conversation answers for every one; a reader lets go of what a
// reading already holds, and what nothing reads stays one per tree.
// Beside them, each directory as the disk names it, by how a caller
// spelled it, so a writer and a reader naming one directory two ways
// (the fence asks by its real path) find the same writes.
const ourWrites = processGlobal(
	"agentic-harness.core/work/memory/written.v2",
	() => ({
		seq: 0,
		byDir: new Map<string, Map<string, RecordWrite>>(),
		canonical: new Map<string, string>(),
	}),
);

/**
 * `dir` as the disk names it, links followed, the one name its record
 * writes and listings are kept under whichever way a caller spells it.
 * Asked of the disk once a spelling; a directory not there yet is named
 * as written, and asked again once it is.
 */
export function recordDirKey(dir: string): string {
	const known = ourWrites.canonical.get(dir);
	if (known !== undefined) return known;
	try {
		const real = realpathSync(dir);
		ourWrites.canonical.set(dir, real);
		return real;
	} catch {
		// Not there yet, or not ours to see: as written, until it is.
		return resolve(dir);
	}
}

/** Note a write to the record of the tree at `path` once it has landed. */
function noteWrite(dir: string, path: string, held?: HeldTree): void {
	const at = recordDirKey(dir);
	let paths = ourWrites.byDir.get(at);
	if (paths === undefined) {
		paths = new Map();
		ourWrites.byDir.set(at, paths);
	}
	ourWrites.seq += 1;
	paths.delete(path);
	paths.set(path, { seq: ourWrites.seq, ...(held ? { held } : {}) });
}

/**
 * How many record writes this process has landed so far: a reading of
 * the directory started now finds every one of them.
 */
export function recordWritesSoFar(): number {
	return ourWrites.seq;
}

/**
 * The records this process wrote or forgot in `dir` after its write
 * `after`, by tree path, in the order they landed.
 */
export function recordWritesSince(
	dir: string,
	after: number,
): ReadonlyMap<string, RecordWrite> {
	const paths = ourWrites.byDir.get(recordDirKey(dir));
	if (paths === undefined) return new Map();
	return new Map([...paths].filter(([, write]) => write.seq > after));
}

/** Let go of the writes to `dir` up to `upTo`, which a reading now holds. */
export function recordWritesRead(dir: string, upTo: number): void {
	const at = recordDirKey(dir);
	const paths = ourWrites.byDir.get(at);
	if (paths === undefined) return;
	for (const [path, write] of paths) {
		if (write.seq <= upTo) paths.delete(path);
	}
	if (paths.size === 0) ourWrites.byDir.delete(at);
}

/** A record as it sits on disk. */
interface Written {
	identity?: HeldTree["identity"];
	path?: string;
	providerId?: string;
}

/**
 * The holders a record names, ignoring anything malformed.
 *
 * Checks that it is an array before filtering it. A record is a file
 * anybody can edit, and `owners: {}` on one of them would otherwise
 * throw out of here and take tidy and reclaim down with it: one bad
 * file, and the whole cleanup path stops for every repo.
 */
function named(tree: HeldTree): readonly Owner[] {
	const owners: unknown = tree.owners;
	if (!Array.isArray(owners)) return [];
	return owners.filter(isOwner);
}

/**
 * Whether a record names somebody and every session it names has ended.
 * A record that names nobody is never spent, since nothing can say so.
 */
async function spent(tree: HeldTree, facts: ProcessFacts): Promise<boolean> {
	const owners = named(tree);
	if (owners.length === 0) return false;
	const once = askedOnceWithTicks(facts === systemFacts ? tickFacts : facts);
	const stands = await Promise.all(
		owners.map((owner) => tickedStanding(owner, once)),
	);
	return stands.every((one) => one === "gone");
}

/** Whether two records name the same conversation or plain pi process. */
function sameOwner(one: Owner, two: Owner): boolean {
	return (
		one.pid === two.pid &&
		sameProcess(one.startedAt, two.startedAt) &&
		one.host === two.host &&
		one.session === two.session
	);
}

/** Keep plain pi fact injection while a host supplies the conversation owner. */
async function holderNow(
	facts: ProcessFacts,
	session?: string,
): Promise<Owner | undefined> {
	return hosted() ? sessionOwner(session) : ownerNow(facts);
}

/** Whether a record read back off disk says enough to be useful. */
function usable(written: Written): written is Required<Written> {
	return (
		typeof written.path === "string" &&
		typeof written.providerId === "string" &&
		typeof written.identity?.key === "string"
	);
}

/** A record found at `at` holding `text`. */
interface Found {
	readonly at: string;
	readonly held: HeldTree;
}

/**
 * The record `text` read from `at` holds, or none when it doesn't parse
 * or says too little.
 */
function parsedRecord(at: string, text: string): Found | undefined {
	try {
		const written: Written = JSON.parse(text);
		// A record we cannot read is worse than no record, because it
		// would mean a tree reported with a broken identity. Skip it and
		// leave it alone: deleting somebody's file to tidy a listing is not
		// this function's decision.
		return usable(written)
			? { at, held: written as unknown as HeldTree }
			: undefined;
	} catch {
		// Half-written, which a concurrent write can produce. The tree is
		// still on disk and still reachable by path; only its identity is
		// lost, and next cut rewrites it.
		return undefined;
	}
}

/**
 * `fn` over each of `items`, `atOnce` running at a time, in order. Once
 * one fails, no lane takes another item: the whole is failed, and a
 * process out of descriptors opens no more for an answer thrown away.
 */
async function eachAtOnce<T, R>(
	items: readonly T[],
	atOnce: number,
	fn: (item: T) => Promise<R>,
): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	let failed = false;
	const lane = async (): Promise<void> => {
		while (!failed && next < items.length) {
			const at = next;
			next += 1;
			try {
				out[at] = await fn(items[at] as T);
			} catch (error) {
				failed = true;
				throw error;
			}
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(atOnce, items.length) }, lane),
	);
	return out;
}

/**
 * The records a reading has read, by file name: a listing the directory
 * moved under is listed again, and only the names it holds no record
 * for are read. A file that held no record when read, gone or half
 * written, stays out, so a later listing that names it reads it again:
 * a record removed and written again at its key during one reading is
 * still found.
 */
type ReadSoFar = Map<string, Found>;

/** The names of the records in `dir`, listed off the thread. */
async function namesOff(dir: string): Promise<string[]> {
	try {
		return (await readdir(dir)).filter((name) => name.endsWith(".json"));
	} catch (error) {
		// No directory yet is no records; anything else fails the reading,
		// so a reader keeps what it had rather than swapping in none.
		if (isGone(error)) return [];
		throw error;
	}
}

/** Each of `names` that `read` lacks, read off the thread into it. */
async function readNewOff(
	dir: string,
	names: readonly string[],
	read: ReadSoFar,
): Promise<void> {
	const fresh = names.filter((name) => !read.has(name));
	const found = await eachAtOnce(fresh, READS_AT_ONCE, async (name) => {
		const at = join(dir, name);
		try {
			return parsedRecord(at, await readFile(at, "utf8"));
		} catch (error) {
			return unreadRecord(error);
		}
	});
	for (const [at, name] of fresh.entries()) {
		const one = found[at];
		if (one) read.set(name, one);
	}
}

/**
 * The records `names` name, from what was read: the last listing's
 * names when it held still, else every name any listing found.
 */
function recordsNamed(names: Iterable<string>, read: ReadSoFar): Found[] {
	return [...names].flatMap((name) => {
		const one = read.get(name);
		return one ? [one] : [];
	});
}

/**
 * What a record that failed to read counts as, read on the thread or off
 * it alike, so the two readers of one folder never disagree. A fault of
 * the moment, the process out of descriptors, fails the whole reading,
 * so a reader keeps what it had rather than a listing a tree is missing
 * from. A record gone since the listing, or one wrong in itself, a
 * folder named as a record, one nobody may read, a loop, is no record:
 * failing on it would fail every reading for as long as it stays.
 */
function unreadRecord(error: unknown): undefined {
	if (isPassingFault(error)) throw error;
	return undefined;
}

/** Whether something stands at `path`, asked off the thread. */
async function standsOff(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		// Not there, or not ours to see: as existsSync answers.
		return false;
	}
}

/**
 * Every tree written down in `dir` that is still on disk, as `recall`
 * answers, read off the thread: a directory of thousands of records
 * read on it held every session in a host while it was read. Read again
 * while the directory moves, as `recall` is. A record whose tree is gone
 * is passed over but left on disk: removed here, holding no lock, after a
 * wait as long as a reading of thousands, it could be a record cut again
 * at the same key since, so removing is left to `recall` and the sweep.
 * A listing that fails rejects rather than answering none. A listing the
 * directory moved under lists its names again, as `all` says why, but
 * reads only the records no listing found before: on a machine at load
 * 85 one reading of 3,870 records took 26 s, and sessions write the
 * folder every few seconds, so reading each again up to eight times ran
 * past the minute a carry waits. That 26 s was main's reader, which
 * read every record again at each listing, timed by hand. A record
 * rewritten while one reading runs is seen as it was when first read,
 * and as rewritten by the next, since the kept listing is stamped from
 * before this one began.
 */
export async function recallOff(dir: string): Promise<HeldTree[]> {
	const read: ReadSoFar = new Map();
	const seen = new Set<string>();
	let settled: string[] | undefined;
	for (let tries = 0; tries < LISTING_TRIES; tries += 1) {
		const before = await stampOff(dir);
		const names = await namesOff(dir);
		await readNewOff(dir, names, read);
		if (before !== undefined && before === (await stampOff(dir))) {
			settled = names;
			break;
		}
		for (const name of names) seen.add(name);
	}
	const trees = recordsNamed(settled ?? seen, read).map(({ held }) => held);
	const stands = await standingOff(trees.map((held) => held.path));
	return trees.filter((_, at) => stands[at]);
}

/** Whether each of `paths` still stands, asked off the thread. */
export async function standingOff(
	paths: readonly string[],
): Promise<boolean[]> {
	return eachAtOnce(paths, READS_AT_ONCE, standsOff);
}

/**
 * Remember trees in a directory of small files, one per tree.
 *
 * A file per tree rather than one index, for the same reason the attachment
 * store is shaped this way: two sessions cutting trees at once both write, and
 * the loser of a read-modify-write race on a single index is a tree nobody can
 * find. Separate files cannot collide, since the name is the tree's own key.
 *
 * Given `sessions`, each tree this session takes up names them by pi
 * session id too: its own, and in a subagent the session that ran it. The
 * sweep reads them to keep a tree any of them still holds.
 */
export function createTreeMemory(
	dir: string,
	known: { sessions?: () => readonly string[] } = {},
): TreeMemory {
	/** The record's sessions, with ours added or, `leaving`, taken out. */
	function sessionsWith(
		tree: HeldTree | undefined,
		leaving = false,
	): { sessions?: string[] } {
		const ours = known.sessions?.() ?? [];
		const before = (Array.isArray(tree?.sessions) ? tree.sessions : []).filter(
			(one): one is string => typeof one === "string" && !ours.includes(one),
		);
		const after = leaving ? before : [...before, ...ours];
		return after.length > 0 ? { sessions: after } : {};
	}

	const fileFor = (key: string): string =>
		join(dir, `${key.replaceAll("/", "-")}.json`);

	/**
	 * The record filed under `key`, when it names the tree at `path` and
	 * that tree stands, read from its one file. A rename over it is atomic,
	 * so the old record or the new one is read, never neither.
	 */
	function recordAt(key: string, path: string): HeldTree | undefined {
		let written: Written;
		try {
			written = JSON.parse(readFileSync(fileFor(key), "utf8"));
		} catch {
			// No record, or one half-written: either reads as no record.
			return undefined;
		}
		return usable(written) && written.path === path && existsSync(path)
			? (written as unknown as HeldTree)
			: undefined;
	}

	/** Run a rewrite of one record with every other session held off it. */
	async function underLock(
		key: string,
		fn: () => Promise<void>,
	): Promise<void> {
		mkdirSync(dir, { recursive: true });
		await withFileLock(fileFor(key), fn);
	}

	/**
	 * Every record the directory named once it held still, or every one any
	 * listing named when it never did. A record is read once a reading, so
	 * one rewritten meanwhile is handed back as first read; a caller that
	 * rewrites a record does so under that record's lock, which keeps the
	 * one it changes still from its first read to its write.
	 *
	 * A listing taken while another session renamed a record over itself
	 * left that record out on btrfs, though the file was there throughout:
	 * 43 times in 1.5 million reads beside six sessions rewriting one
	 * record, each during a listing the directory's change time moved
	 * across. A missed record reads as a tree nobody else holds, which a
	 * release takes down and a holder rewriting the owners drops everyone
	 * from. So a listing the directory changed under is read again, and
	 * when it never holds still, every record any listing found is kept,
	 * since a record seen once is a tree somebody may be standing in. For
	 * the same reason a record the disk fails to hand over for now, out
	 * of descriptors, fails the whole reading rather than reading as none
	 * (`unreadRecord`). A listing read again lists only names, reading
	 * just the records it hadn't read, as `recallOff` says why.
	 */
	function all(): readonly { at: string; held: HeldTree }[] {
		if (!existsSync(dir)) return [];
		const read: ReadSoFar = new Map();
		const seen = new Set<string>();
		for (let tries = 0; tries < LISTING_TRIES; tries += 1) {
			const before = stamp(dir);
			const names = namesNow();
			readNew(names, read);
			if (before !== undefined && before === stamp(dir)) {
				return recordsNamed(names, read);
			}
			for (const name of names) seen.add(name);
		}
		return recordsNamed(seen, read);
	}

	/** The names of the records in the directory, listed on the thread. */
	function namesNow(): string[] {
		if (!existsSync(dir)) return [];
		return readdirSync(dir).filter((name) => name.endsWith(".json"));
	}

	/** Each of `names` that `read` lacks, read on the thread into it. */
	function readNew(names: readonly string[], read: ReadSoFar): void {
		for (const name of names) {
			if (read.has(name)) continue;
			const at = join(dir, name);
			let text: string;
			try {
				text = readFileSync(at, "utf8");
			} catch (error) {
				// A passing fault fails the reading; anything else is no record.
				unreadRecord(error);
				continue;
			}
			const one = parsedRecord(at, text);
			if (one) read.set(name, one);
		}
	}

	return {
		remember(held) {
			mkdirSync(dir, { recursive: true });
			const file = fileFor(held.identity.key);
			// Written beside the record and renamed over it, so another
			// session reading at the same moment finds the old record or the
			// new one. A half-written one reads as no record, and a holder
			// rewriting the owners from no record drops everybody else. The
			// name does not end in .json, so a listing never reads one.
			const staging = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
			try {
				writeFileSync(staging, JSON.stringify(held, null, 2), "utf8");
				renameSync(staging, file);
			} catch (error) {
				rmSync(staging, { force: true });
				throw error;
			}
			noteWrite(dir, held.path, held);
		},

		async rememberHeldByUs(held, facts = systemFacts) {
			// Stamped here rather than by the caller, so a tree cannot be
			// written down without the identity that lets it be released
			// later. The holder is the calling conversation in a host, or
			// the calling process on plain pi.
			const us = await holderNow(facts);
			if (us === undefined) {
				// The machine will not say when we started, so we cannot write
				// an identity anybody could check later. Recording the tree
				// without one is right: it reads as unattributable, which is
				// held, and a tree wrongly held costs disk where a tree
				// wrongly reclaimed costs work.
				// Under the lock all the same, since a sweep judges a record's
				// use under it.
				await underLock(held.identity.key, async () => {
					this.remember({ ...held, ...sessionsWith(held), usedAt: Date.now() });
				});
				return;
			}
			// Added to whoever else holds it rather than replacing them. A
			// snapshot is shareable, so two sessions can hold one tree, and
			// the one that wrote last is not the only one that would miss it.
			// Dead holders are left to be filtered on the way out rather than
			// probed here, since this is on the path of every cut. Read and
			// written under the record's lock, since another session adding
			// itself between the two would otherwise be written out again.
			await underLock(held.identity.key, async () => {
				const found = this.recall().find((tree) => tree.path === held.path);
				const before = (found?.owners ?? held.owners ?? []).filter(
					(one) => isOwner(one) && !sameOwner(one, us),
				);
				const { sessions: _, ...rest } = held;
				this.remember({
					...rest,
					owners: [...before, us],
					...sessionsWith(found ?? held),
					usedAt: Date.now(),
				});
			});
		},

		forget(path) {
			for (const { at, held } of all()) {
				if (held.path === path) rmSync(at, { force: true });
			}
			noteWrite(dir, path);
		},

		recall() {
			const found: HeldTree[] = [];
			for (const { at, held } of all()) {
				// The directory is the truth. A record whose tree has been
				// removed by hand is dropped and its record with it, which is
				// how somebody who cleaned up by hand stops being nagged about
				// it forever.
				if (existsSync(held.path)) {
					found.push(held);
					continue;
				}
				rmSync(at, { force: true });
				noteWrite(dir, held.path);
			}
			return found;
		},

		unattributed() {
			return this.recall().filter((tree) => named(tree).length === 0);
		},

		async otherHolders(path, facts = systemFacts) {
			const tree = this.recall().find((one) => one.path === path);
			if (tree === undefined) return [];
			const once = askedOnceWithTicks(
				facts === systemFacts ? tickFacts : facts,
			);
			const us = await holderNow(once);
			const others: Owner[] = [];
			for (const owner of named(tree)) {
				if (us !== undefined && sameOwner(owner, us)) continue;
				if ((await tickedStanding(owner, once)) !== "gone") others.push(owner);
			}
			return others;
		},

		async heldByUs(trees, facts = systemFacts) {
			const us = await holderNow(facts);
			if (us === undefined) return new Set();
			return new Set(
				trees
					.filter((tree) => named(tree).some((one) => sameOwner(one, us)))
					.map((tree) => tree.path),
			);
		},

		async forgetUsAsHolder(path, facts = systemFacts) {
			const found = this.recall().find((one) => one.path === path);
			if (found === undefined) return;
			const us = await holderNow(facts);
			if (us === undefined) return;
			// Read again under the lock: what was found above may already
			// be missing a holder that arrived since.
			await underLock(found.identity.key, async () => {
				const tree = this.recall().find((one) => one.path === path);
				if (tree === undefined) return;
				const { sessions: _, ...rest } = tree;
				this.remember({
					...rest,
					owners: named(tree).filter((owner) => !sameOwner(owner, us)),
					...sessionsWith(tree, true),
				});
			});
		},

		async whileUnheld(path, take, facts = systemFacts) {
			const found = this.recall().find((one) => one.path === path);
			if (found === undefined) return undefined;
			let taken: HeldTree | undefined;
			await underLock(found.identity.key, async () => {
				const tree = this.recall().find((one) => one.path === path);
				if (tree === undefined || !(await spent(tree, facts))) return;
				if (!(await take())) return;
				this.forget(path);
				taken = tree;
			});
			return taken;
		},

		async whileUnusedSince(path, since, take, key) {
			const find = (): HeldTree | undefined =>
				key === undefined
					? this.recall().find((one) => one.path === path)
					: recordAt(key, path);
			const found = find();
			if (found === undefined) return undefined;
			let taken: HeldTree | undefined;
			await underLock(found.identity.key, async () => {
				const tree = find();
				const asked = this.askedAt(path, found.identity.key);
				if (
					tree === undefined ||
					asked === undefined ||
					Math.max(asked, tree.usedAt ?? 0) > since
				)
					return;
				if (!(await take())) return;
				if (key === undefined) this.forget(path);
				// One filed under another name names a tree now gone, which the
				// next listing drops.
				else {
					rmSync(fileFor(key), { force: true });
					noteWrite(dir, path);
				}
				taken = tree;
			});
			return taken;
		},

		askedAt(path, key) {
			const at =
				key === undefined
					? all().find(({ held }) => held.path === path)?.at
					: fileFor(key);
			if (at === undefined) return undefined;
			try {
				return statSync(at).mtimeMs;
			} catch {
				// Gone since the listing: a take or a release forgot it.
				return undefined;
			}
		},

		async holdWhileUnheld(path, facts = systemFacts) {
			const found = this.recall().find((one) => one.path === path);
			if (found === undefined) return undefined;
			const us = await holderNow(facts);
			if (us === undefined) return undefined;
			let before: HeldTree | undefined;
			await underLock(found.identity.key, async () => {
				const tree = this.recall().find((one) => one.path === path);
				if (tree === undefined || !(await spent(tree, facts))) return;
				const { sessions: _, ...rest } = tree;
				this.remember({ ...rest, owners: [us] });
				before = tree;
			});
			return before;
		},

		async heldNow(facts = systemFacts) {
			const held: HeldTree[] = [];
			// One question per process, not per record. Every reviewer of
			// one round shares a session, so the same handful of pids
			// recurs across the whole directory: without this, tidy forked
			// `ps` once per record, serially, which is 59 spawns on the
			// machine this was found on.
			//
			// The fact is cached, never the verdict. A standing compares
			// the pid's real start time against the one a given record
			// wrote down, so it belongs to the record and not to the pid:
			// held per pid, one stale record answers for a live session
			// wearing the same number, which is the exact confusion this
			// module exists to prevent.
			const once = askedOnceWithTicks(
				facts === systemFacts ? tickFacts : facts,
			);

			for (const tree of this.recall()) {
				const owners = named(tree);
				// Nobody recorded means nobody can say, and every record
				// written before owners existed is one of these. Reading it as
				// nobody's would offer a live session's trees for reclaiming on
				// the first run of this code, which is worse than the leak it
				// fixes.
				if (owners.length === 0) {
					held.push(tree);
					continue;
				}
				// Any one of them is enough. A shared snapshot outlives the
				// first holder to finish with it.
				const stands = await Promise.all(
					owners.map((owner) => tickedStanding(owner, once)),
				);
				if (stands.some((one) => one !== "gone")) held.push(tree);
			}
			return held;
		},

		async reownSession(session, facts = systemFacts) {
			// Only a tree the session itself held: an owner names it. A tree
			// a subagent cut lists the session that ran it too, and re-owning
			// that would make the runner a holder of its lane's tree and turn
			// the lane's next job away from it.
			const names = (tree: HeldTree) =>
				named(tree).some((owner) => owner.session === session);
			const ours = this.recall().filter(names);
			if (ours.length === 0) return 0;
			const us = await holderNow(facts, session);
			// The machine won't say when we started: the records stay as they
			// are, since an owner nobody can check is worse than an old one.
			if (us === undefined) return 0;
			const once = askedOnceWithTicks(
				facts === systemFacts ? tickFacts : facts,
			);
			let changed = 0;
			for (const found of ours) {
				// Read again under the lock, so a holder that arrived since the
				// listing is kept.
				const reowned = underLock(found.identity.key, async () => {
					const tree = this.recall().find((one) => one.path === found.path);
					if (tree === undefined || !names(tree)) return;
					const owners = named(tree);
					const kept: Owner[] = [];
					for (const owner of owners) {
						if (sameOwner(owner, us) || owner.session === session) continue;
						if ((await tickedStanding(owner, once)) === "gone") continue;
						kept.push(owner);
					}
					const already =
						owners.some((owner) => sameOwner(owner, us)) &&
						kept.length === owners.length - 1;
					if (already) return;
					this.remember({ ...tree, owners: [...kept, us] });
					changed += 1;
				});
				try {
					await reowned;
				} catch {
					// One record that can't be rewritten keeps its old owner, as
					// before; the rest of the session's trees still follow it.
				}
			}
			return changed;
		},
	};
}

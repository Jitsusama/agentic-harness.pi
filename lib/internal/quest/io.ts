/**
 * Atomic file IO and per-quest advisory locks.
 *
 * Quest READMEs are read-modify-write at every action,
 * potentially from two pi sessions attached to the same
 * quest at the same time. Two concerns:
 *
 * 1. Torn reads. The "read text, parse, mutate, write
 *    text" sequence is not atomic against a concurrent
 *    reader; on a slow disk a reader sees half a file.
 *    We write to a temp file in the folder's `.writing`,
 *    fsync, then rename over the target so observers
 *    always see the old or new file in full.
 *
 * 2. Lost updates. Two pi sessions running in parallel
 *    both load the README, both mutate frontmatter
 *    in-memory, both write back: the second overwrites
 *    the first. We take a coarse per-quest lock around
 *    the read-modify-write so the second waits.
 *
 * Neither the temp file nor the lock is made in the quest
 * folder itself: the shell watches the folders of quests
 * with something waiting on Joel, and each file made and
 * removed there woke it (6b, 31 October). The temp file
 * lives in the folder's `.writing`, which its watch
 * doesn't reach.
 *
 * The lock lives in the login's runtime folder, which is
 * tmpfs: on 16 and 17 November the hosts' loops held about
 * 77 s creating and removing it in `.writing`, waiting on
 * btrfs's tree lock while the disk was busy, and nothing
 * made on tmpfs waits on the disk. Every writer on the
 * machine must pick the same lock, so the folder is found
 * without `XDG_RUNTIME_DIR`, which a pi from cron or ssh
 * lacks: `/run/user/<uid>`, when it holds the session bus.
 * The fence gives a command a private runtime folder of
 * its own, never with the bus, and binds this one folder
 * back in, so a pi inside it locks there too. A machine
 * without a login runtime folder, as the Mac, locks in
 * `.writing` as before; one locking in the runtime folder
 * still waits out a lock there, held by older code.
 *
 * The lock is file-creation with `O_EXCL`. A short retry
 * loop covers the normal contention case; a stale-lock
 * sweep kicks in when the lock is older than
 * `STALE_LOCK_MS` so a crashed pi cannot wedge the quest
 * for the rest of time. The lock is advisory: a process
 * that bypasses it can still write through. We rely on
 * every README write going through `withQuestLock`.
 */

import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmdirSync,
	type Stats,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { join, sep } from "node:path";
import { WRITING, writeWhole } from "../write-whole.ts";
import { isId, prefixOf } from "./creation/id.ts";
import { questLockFolder } from "./lock-folder.ts";
import { journalIn, noteQuestWrite } from "./write-journal.ts";

/** Lock-acquire retry budget per call. */
const LOCK_TIMEOUT_MS = 5000;
/** Sleep between retries. */
const LOCK_RETRY_MS = 25;
/** A lock older than this is considered stale and stolen. */
const STALE_LOCK_MS = 30_000;
/**
 * How far ahead of now a lock may be dated before it is judged made up:
 * every writer reads one clock, so this covers only its coarse ticks.
 */
const AHEAD_MS = 1000;

/** The lock's name in the quest folder's `.writing`. */
const LOCK_NAME = "quest.lock";

/** Where a process's pid namespace is named, on Linux. */
const PID_NAMESPACE = "/proc/self/ns/pid";

/** Where tests have the runtime folder looked for, when they say. */
let runFolderForTests: string | undefined;

/**
 * The folder quest locks are made in on this machine, or undefined to
 * make each in its quest's `.writing`. Looked for on every lock, since
 * one stat on tmpfs is cheap and a process started before the login's
 * folder was made must not keep `.writing` once it is there.
 *
 * Where the login's runtime folder holds its session bus, the folder in
 * it, made if it isn't there. Inside the fence the bus is hidden but
 * the folder is bound back in, so a fenced writer finds it as well.
 * Where neither is, as on the Mac, every writer keeps `.writing`. Where
 * something other than a folder of this user's alone stands in its
 * place, as the fence leaves when it won't let the folder through, no
 * quest is written: locking in `.writing` there would be locking alone
 * (ISXEG8 and 85PKB2, 17 November).
 */
function runtimeLocks(): string | undefined {
	const run =
		runFolderForTests ??
		(process.getuid ? `/run/user/${process.getuid()}` : undefined);
	if (run === undefined) return undefined;
	const { folder, stands } = questLockFolder(run);
	if (stands === "refused") {
		throw new Error(
			`Wrote no quest: the quest lock folder ${folder} is missing, a link, a file or another user's, and a lock anywhere else is one other writers never see. Outside the fence, remove what stands there and the next write makes the folder again; inside, the fence put an empty file there because the folder outside was like that.`,
		);
	}
	return stands === "ours" ? folder : undefined;
}

/**
 * This process's pid namespace, or undefined where there is no `/proc`,
 * as on the Mac. Read on every lock, since it is one read of procfs.
 */
function pidNamespace(): string | undefined {
	try {
		return readlinkSync(PID_NAMESPACE);
	} catch {
		// No /proc here, so every writer is judged by its pid as before.
		return undefined;
	}
}

/**
 * Where the lock was made, in the quest folder itself, by sessions on
 * code from before 31 October. A session reloads onto new code only
 * between runs, so for a while both kinds write the same quests: one
 * holding the new lock waits while an older one holds this, and so
 * never writes over it. An older session doesn't know the new lock,
 * so the two can still overlap if it takes this one in the moment
 * between that wait and the write, until every session has reloaded.
 */
const LEGACY_LOCK_NAME = ".quest.lock";

/**
 * Write `data` to `path` atomically: write a temp file in
 * the folder's `.writing`, fsync, then rename over the
 * target. The rename is atomic on POSIX filesystems for
 * files on the same volume.
 */
export function atomicWriteFile(path: string, data: string): void {
	try {
		writeWhole(path, data, { durable: true });
	} finally {
		wrote(path);
	}
}

/**
 * Where the process counts the quest writes it makes: on `globalThis`,
 * as discovery keeps its memo, since every extension that imports this
 * file has a copy of it and each copy's writes must reach one count.
 */
const WRITES = Symbol.for("agentic-harness.quest-writes");

type WriteCount = Record<symbol, number | undefined>;

/**
 * Where the process logs which quest each counted write landed in,
 * beside the count and shared the same way. A copy of this file loaded
 * before the log counts without logging, which `questsWrittenSince`
 * sees as a write it can't place.
 */
const WRITTEN = Symbol.for("agentic-harness.quest-writes-placed");

/** A counted write: the count it made, and the quest it landed in. */
interface PlacedWrite {
	readonly count: number;
	readonly quest: string | undefined;
}

type WriteLog = Record<symbol, PlacedWrite[] | undefined>;

/**
 * How many placed writes the log keeps. A host's discovery reads it
 * within seconds of each write; one asking about a write older than
 * this signs its whole tree again instead.
 */
const WRITES_LOGGED = 4096;

/** Count one more write this process made to a quest, at `path`. */
function wrote(path: string): void {
	const global = globalThis as WriteCount;
	const count = (global[WRITES] ?? 0) + 1;
	global[WRITES] = count;
	const logs = globalThis as WriteLog;
	const log = logs[WRITTEN] ?? [];
	logs[WRITTEN] = log;
	log.push({ count, quest: questOf(path) });
	if (log.length > WRITES_LOGGED) log.splice(0, log.length - WRITES_LOGGED);
	const dir = questDirOf(path);
	const journal = dir === undefined ? undefined : questJournal();
	if (dir !== undefined && journal !== undefined) noteQuestWrite(journal, dir);
}

/**
 * Count a write this process made to a quest without io.ts, as pi's
 * write and edit tools make, at `path`: noted in the journal, so every
 * host's discovery, this one's too, reads it at its next ask rather
 * than at its next whole signing.
 */
export function noteWriteMadeElsewhere(path: string): void {
	wrote(path);
}

/**
 * The journal of quest writes every process on this machine appends to
 * and every host's discovery reads (`write-journal.ts`), beside the
 * quest locks; undefined where the locks have no runtime folder, as on
 * the Mac, or where the fence refused it, so discovery walks as before.
 */
export function questJournal(): string | undefined {
	try {
		const folder = runtimeLocks();
		return folder === undefined ? undefined : journalIn(folder);
	} catch {
		// A refused lock folder refuses the write itself; no journal here.
		return undefined;
	}
}

/**
 * The quest folder `questOf` names for `path`, as the whole path to
 * it: undefined for a path in no quest.
 */
function questDirOf(path: string): string | undefined {
	const parts = path.split(sep);
	const at = parts.findIndex((part) => isId(part) && prefixOf(part) === "QEST");
	return at < 0 ? undefined : parts.slice(0, at + 1).join(sep);
}

/**
 * The quest folder that holds `path`: the outermost folder on it named
 * as a quest, which is the quests root's entry discovery reads again,
 * even for a quest misplaced inside another. A path in none, as a
 * session's record, is in no quest.
 */
function questOf(path: string): string | undefined {
	return path
		.split(sep)
		.find((part) => isId(part) && prefixOf(part) === "QEST");
}

/**
 * The quests this process wrote to since its count stood at `since`,
 * by id; none for writes outside any quest. Undefined when a write
 * since can't be placed: one counted by code that logs nothing, or
 * older than the log keeps.
 */
export function questsWrittenSince(
	since: number,
): ReadonlySet<string> | undefined {
	const now = questWritesMade();
	if (now === since) return new Set();
	const log = (globalThis as WriteLog)[WRITTEN] ?? [];
	const placed = log.filter((write) => write.count > since);
	if (placed.length !== now - since) return undefined;
	const quests = new Set<string>();
	for (const write of placed) if (write.quest) quests.add(write.quest);
	return quests;
}

/**
 * How many quest writes this process has made: each atomic write, and
 * each stretch under a quest's lock, which covers the appends and
 * removals made there. A held discovery reads it to see its own writes.
 */
export function questWritesMade(): number {
	return (globalThis as WriteCount)[WRITES] ?? 0;
}

interface LockRecord {
	pid: number;
	startedAt: number;
	/**
	 * The holder's pid namespace: a fenced writer's pid names another
	 * process, or none, outside its own. Absent from older code's locks.
	 */
	pidns?: string;
}

function readLockRecord(lockPath: string): LockRecord | undefined {
	try {
		// Never through a link, and never waiting on a pipe: a fenced command
		// can write the shared lock folder, and a read that blocked would
		// hold every conversation on the host's thread.
		const fd = openSync(
			lockPath,
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
		let text: string;
		try {
			if (!fstatSync(fd).isFile()) return undefined;
			text = readFileSync(fd, "utf8");
		} finally {
			closeSync(fd);
		}
		const parsed = JSON.parse(text) as {
			pid?: unknown;
			startedAt?: unknown;
			pidns?: unknown;
		};
		const pid =
			typeof parsed.pid === "number" && Number.isFinite(parsed.pid)
				? parsed.pid
				: undefined;
		const startedAt =
			typeof parsed.startedAt === "number" && Number.isFinite(parsed.startedAt)
				? parsed.startedAt
				: undefined;
		if (pid === undefined || startedAt === undefined) return undefined;
		if (typeof parsed.pidns !== "string") return { pid, startedAt };
		return { pid, startedAt, pidns: parsed.pidns };
	} catch {
		// Lock file is malformed or unreadable. Treat as stale
		// so the steal loop can recover instead of wedging.
		return undefined;
	}
}

function isProcessAlive(pid: number): boolean {
	if (pid <= 0 || pid === process.pid) return false;
	try {
		// kill(pid, 0) probes whether the pid exists; throws
		// ESRCH when it doesn't and EPERM when it does but we
		// can't signal it. Either non-throw is "alive enough".
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Take the lock over if its holder has gone or it is too old to be a
 * write in progress.
 *
 * A lock with no readable record is judged by its file's age alone: a
 * holder creates the lock and then writes its record, so for a moment
 * every live lock is empty, and treating that as abandoned took locks
 * from their holders. Taking over moves the lock aside and checks the
 * move took the one judged stale; deleting by name could delete a lock
 * another writer made after taking over first.
 */
function tryStealStaleLock(lockPath: string, now: number): boolean {
	let judged: ReturnType<typeof lstatSync>;
	try {
		judged = lstatSync(lockPath);
	} catch {
		// Released since the failed create; the next attempt takes it.
		return true;
	}
	const record = readLockRecord(lockPath);
	// A pid from another namespace says nothing here, so such a lock is
	// judged by its age alone.
	const here = record?.pidns === undefined || record.pidns === pidNamespace();
	// No writer makes anything but a file, nor dates one ahead: anything
	// else there would otherwise wedge the quest until someone removed it.
	const stale = !judged.isFile()
		? true
		: record
			? now - record.startedAt >= STALE_LOCK_MS ||
				record.startedAt > now + AHEAD_MS ||
				(here && !isProcessAlive(record.pid))
			: now - judged.mtimeMs >= STALE_LOCK_MS ||
				judged.mtimeMs > now + AHEAD_MS;
	if (!stale) return false;
	const aside = `${lockPath}.stale-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
	try {
		renameSync(lockPath, aside);
	} catch {
		// Somebody else took it over first; the next attempt sees theirs.
		return false;
	}
	const moved = lstatSync(aside);
	if (moved.ino !== judged.ino) {
		// Moved a fresh lock another writer made after taking over first.
		// Put it back, unless a third already made one, which then stands.
		try {
			linkSync(aside, lockPath);
		} catch {
			// EEXIST: the newer lock stands, as above.
		}
	}
	clearAside(aside, moved);
	return true;
}

/**
 * Remove what a takeover moved aside, never walking into it. A fenced
 * command can write the lock folder, and a recursive delete of a folder it
 * made can be led out of the fence by a link it swaps in mid-walk (ISXEG8,
 * 17 November). So a folder goes only if it is empty; one that isn't stays
 * under its aside name, which already freed the lock's, until tmpfs clears
 * it at logout.
 */
function clearAside(aside: string, moved: Stats): void {
	try {
		if (moved.isDirectory()) rmdirSync(aside);
		else unlinkSync(aside);
	} catch {
		// Not empty, or changed since: left aside, which holds no lock's name.
	}
}

/** Why a writer gave up on a quest's lock, naming the quest, not just the lock. */
function timedOut(questDir: string, lockPath: string): Error {
	return new Error(
		`Timed out acquiring the lock of quest ${questDir} at ${lockPath} after ${LOCK_TIMEOUT_MS}ms.`,
	);
}

function acquireLock(
	questDir: string,
	lockPath: string,
): { fd: number; ino: number } {
	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	let lastStealCheck = 0;
	while (true) {
		try {
			const fd = openSync(lockPath, "wx");
			const pidns = pidNamespace();
			const payload: LockRecord = {
				pid: process.pid,
				startedAt: Date.now(),
				...(pidns === undefined ? {} : { pidns }),
			};
			// Not flushed: other writers read the record from the page cache
			// they share, and a lock a power cut empties is judged by its age.
			// Flushing each lock cost every quest write a disk wait.
			writeSync(fd, JSON.stringify(payload));
			return { fd, ino: fstatSync(fd).ino };
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "EEXIST") throw err;
		}
		const now = Date.now();
		if (now >= deadline) throw timedOut(questDir, lockPath);
		// Probe for staleness every couple of retries so a
		// crashed holder doesn't keep us spinning.
		if (now - lastStealCheck > LOCK_RETRY_MS * 4) {
			tryStealStaleLock(lockPath, now);
			lastStealCheck = now;
		}
		pauseForRetry();
	}
}

/**
 * Wait until no older session holds the legacy lock, taking it over
 * only when it is stale, as a holder of it would be; never making it.
 */
function awaitLegacyRelease(questDir: string, legacyPath: string): void {
	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	let lastStealCheck = 0;
	while (existsSync(legacyPath)) {
		const now = Date.now();
		if (now >= deadline) throw timedOut(questDir, legacyPath);
		if (now - lastStealCheck > LOCK_RETRY_MS * 4) {
			tryStealStaleLock(legacyPath, now);
			lastStealCheck = now;
		}
		pauseForRetry();
	}
}

/**
 * Busy-wait between retries. Node has no blocking sleep without async,
 * and the caller is already running a synchronous read-modify-write.
 */
function pauseForRetry(): void {
	const sleepUntil = Date.now() + LOCK_RETRY_MS;
	while (Date.now() < sleepUntil) {
		// spin
	}
}

function releaseLock(
	lockPath: string,
	held: { fd: number; ino: number },
): void {
	try {
		closeSync(held.fd);
	} catch {
		// Already closed; cleanup of the path below still runs.
	}
	try {
		// Only this holder's own lock: one taken over from it belongs to
		// whoever made the new one.
		if (statSync(lockPath).ino === held.ino) unlinkSync(lockPath);
	} catch {
		// Lock file was stolen out from under us or never
		// committed; nothing more we can do.
	}
}

/**
 * Run `fn` under an advisory lock on the given quest dir.
 * Acquires the quest's lock in the login's runtime folder,
 * keyed by the quest folder's device and inode, or where
 * there is none `<questDir>/.writing/quest.lock`; inside the
 * fence, the same folder, bound back in. Waits out the lock
 * in `.writing` that a writer on older code holds, and any
 * older session's `<questDir>/.quest.lock`, runs fn,
 * releases. Steals a lock older than `STALE_LOCK_MS`, or
 * one whose owner in this pid namespace is no longer alive.
 */
export function withQuestLock<T>(questDir: string, fn: () => T): T {
	let folder: ReturnType<typeof statSync>;
	try {
		folder = statSync(questDir);
	} catch {
		// Gone, or never made: said as the caller's error below.
		throw new Error(`Quest directory ${questDir} does not exist.`);
	}
	const inWriting = join(questDir, WRITING, LOCK_NAME);
	const runtime = runtimeLocks();
	const lockPath = runtime
		? join(runtime, `${folder.dev}-${folder.ino}.lock`)
		: inWriting;
	mkdirSync(runtime ?? join(questDir, WRITING), {
		recursive: true,
		mode: 0o700,
	});
	// Probe once before the loop so we don't wait the full
	// retry budget on a clearly-stale lock.
	if (existsSync(lockPath)) {
		try {
			const age = Date.now() - statSync(lockPath).mtimeMs;
			if (age > STALE_LOCK_MS) tryStealStaleLock(lockPath, Date.now());
		} catch {
			// Stat failed; the acquire loop handles it.
		}
	}
	const held = acquireLock(questDir, lockPath);
	try {
		if (runtime) awaitLegacyRelease(questDir, inWriting);
		awaitLegacyRelease(questDir, join(questDir, LEGACY_LOCK_NAME));
		return fn();
	} finally {
		wrote(questDir);
		releaseLock(lockPath, held);
	}
}

/**
 * Look for the login's runtime folder at `folder` rather than
 * `/run/user/<uid>`, or there again given undefined, for tests.
 */
export function useRunFolderForTests(folder: string | undefined): void {
	runFolderForTests = folder;
}

/** Fallback when we have a path but no enclosing quest dir. */
export function atomicWriteUnderLock(
	questDir: string,
	path: string,
	contents: string,
): void {
	withQuestLock(questDir, () => {
		atomicWriteFile(path, contents);
	});
}

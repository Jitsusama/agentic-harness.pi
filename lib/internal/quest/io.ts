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
 * removed there woke it (6b, 31 October). Both live in
 * the folder's `.writing`, which its watch doesn't reach.
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
	existsSync,
	fstatSync,
	fsyncSync,
	linkSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";
import { WRITING, writeWhole } from "../write-whole.ts";

/** Lock-acquire retry budget per call. */
const LOCK_TIMEOUT_MS = 5000;
/** Sleep between retries. */
const LOCK_RETRY_MS = 25;
/** A lock older than this is considered stale and stolen. */
const STALE_LOCK_MS = 30_000;

/** The lock's name in the quest folder's `.writing`. */
const LOCK_NAME = "quest.lock";

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
	writeWhole(path, data, { durable: true });
}

interface LockRecord {
	pid: number;
	startedAt: number;
}

function readLockRecord(lockPath: string): LockRecord | undefined {
	try {
		const text = readFileSync(lockPath, "utf8");
		const parsed = JSON.parse(text) as { pid?: unknown; startedAt?: unknown };
		const pid =
			typeof parsed.pid === "number" && Number.isFinite(parsed.pid)
				? parsed.pid
				: undefined;
		const startedAt =
			typeof parsed.startedAt === "number" && Number.isFinite(parsed.startedAt)
				? parsed.startedAt
				: undefined;
		if (pid === undefined || startedAt === undefined) return undefined;
		return { pid, startedAt };
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
	let judged: ReturnType<typeof statSync>;
	try {
		judged = statSync(lockPath);
	} catch {
		// Released since the failed create; the next attempt takes it.
		return true;
	}
	const record = readLockRecord(lockPath);
	const stale = record
		? now - record.startedAt >= STALE_LOCK_MS || !isProcessAlive(record.pid)
		: now - judged.mtimeMs >= STALE_LOCK_MS;
	if (!stale) return false;
	const aside = `${lockPath}.stale-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
	try {
		renameSync(lockPath, aside);
	} catch {
		// Somebody else took it over first; the next attempt sees theirs.
		return false;
	}
	if (statSync(aside).ino !== judged.ino) {
		// Moved a fresh lock another writer made after taking over first.
		// Put it back, unless a third already made one, which then stands.
		try {
			linkSync(aside, lockPath);
		} catch {
			// EEXIST: the newer lock stands, as above.
		}
	}
	unlinkSync(aside);
	return true;
}

function acquireLock(lockPath: string): { fd: number; ino: number } {
	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	let lastStealCheck = 0;
	while (true) {
		try {
			const fd = openSync(lockPath, "wx");
			const payload: LockRecord = {
				pid: process.pid,
				startedAt: Date.now(),
			};
			writeSync(fd, JSON.stringify(payload));
			fsyncSync(fd);
			return { fd, ino: fstatSync(fd).ino };
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "EEXIST") throw err;
		}
		const now = Date.now();
		if (now >= deadline) {
			throw new Error(
				`Timed out acquiring quest lock at ${lockPath} after ${LOCK_TIMEOUT_MS}ms.`,
			);
		}
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
function awaitLegacyRelease(legacyPath: string): void {
	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	let lastStealCheck = 0;
	while (existsSync(legacyPath)) {
		const now = Date.now();
		if (now >= deadline) {
			throw new Error(
				`Timed out acquiring quest lock at ${legacyPath} after ${LOCK_TIMEOUT_MS}ms.`,
			);
		}
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
 * Acquires `<questDir>/.writing/quest.lock`, waits out any
 * older session's `<questDir>/.quest.lock`, runs fn,
 * releases. Steals locks older than `STALE_LOCK_MS` whose
 * owner is no longer alive.
 */
export function withQuestLock<T>(questDir: string, fn: () => T): T {
	if (!existsSync(questDir)) {
		throw new Error(`Quest directory ${questDir} does not exist.`);
	}
	const writing = join(questDir, WRITING);
	mkdirSync(writing, { recursive: true });
	const lockPath = join(writing, LOCK_NAME);
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
	const held = acquireLock(lockPath);
	try {
		awaitLegacyRelease(join(questDir, LEGACY_LOCK_NAME));
		return fn();
	} finally {
		releaseLock(lockPath, held);
	}
}

/**
 * Convenience helper: lock the quest, write the README
 * atomically, release. Most call sites use this directly.
 */
export function writeQuestReadmeAtomic(
	questDir: string,
	contents: string,
): void {
	withQuestLock(questDir, () => {
		atomicWriteFile(join(questDir, "README.md"), contents);
	});
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

/** Synchronous sleep used in tests when emulating contention. */
export const __testing = {
	LOCK_TIMEOUT_MS,
	STALE_LOCK_MS,
};

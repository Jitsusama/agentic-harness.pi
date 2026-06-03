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
 *    We write to a sibling temp file, fsync, then rename
 *    over the target so observers always see the old or
 *    new file in full.
 *
 * 2. Lost updates. Two pi sessions running in parallel
 *    both load the README, both mutate frontmatter
 *    in-memory, both write back: the second overwrites
 *    the first. We take a coarse per-quest lock around
 *    the read-modify-write so the second waits.
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
	fsyncSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

/** Lock-acquire retry budget per call. */
const LOCK_TIMEOUT_MS = 5000;
/** Sleep between retries. */
const LOCK_RETRY_MS = 25;
/** A lock older than this is considered stale and stolen. */
const STALE_LOCK_MS = 30_000;

const LOCK_NAME = ".quest.lock";

/**
 * Write `data` to `path` atomically: write to a sibling
 * temp file in the same directory, fsync, then rename
 * over the target. The rename is atomic on POSIX
 * filesystems for files on the same volume.
 */
export function atomicWriteFile(path: string, data: string): void {
	const dir = dirname(path);
	const tmp = join(
		dir,
		`.${path.split("/").pop()}.tmp-${process.pid}-${Math.random()
			.toString(36)
			.slice(2, 10)}`,
	);
	const fd = openSync(tmp, "w");
	try {
		writeSync(fd, data);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	try {
		renameSync(tmp, path);
	} catch (err) {
		try {
			unlinkSync(tmp);
		} catch {
			// Best-effort cleanup; the temp's leftover state is
			// safe to leave in place and is not user-visible.
		}
		throw err;
	}
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

function tryStealStaleLock(lockPath: string, now: number): boolean {
	const record = readLockRecord(lockPath);
	if (!record) {
		// Malformed lock file; remove and retry.
		try {
			unlinkSync(lockPath);
		} catch {
			// Another process beat us to the cleanup; that's fine.
		}
		return true;
	}
	const age = now - record.startedAt;
	if (age < STALE_LOCK_MS && isProcessAlive(record.pid)) return false;
	try {
		unlinkSync(lockPath);
		return true;
	} catch {
		// Another process beat us to the cleanup; let the
		// next loop iteration retry the acquire.
		return false;
	}
}

function acquireLock(lockPath: string): number {
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
			return fd;
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
		// Busy-wait inside the retry budget. Node has no
		// blocking sleep without async, and the caller is
		// already running a synchronous read-modify-write.
		const sleepUntil = Date.now() + LOCK_RETRY_MS;
		while (Date.now() < sleepUntil) {
			// spin
		}
	}
}

function releaseLock(lockPath: string, fd: number): void {
	try {
		closeSync(fd);
	} catch {
		// Already closed; cleanup of the path below still runs.
	}
	try {
		unlinkSync(lockPath);
	} catch {
		// Lock file was stolen out from under us or never
		// committed; nothing more we can do.
	}
}

/**
 * Run `fn` under an advisory lock on the given quest dir.
 * Acquires `<questDir>/.quest.lock`, runs fn, releases.
 * Steals locks older than `STALE_LOCK_MS` whose owner is
 * no longer alive.
 */
export function withQuestLock<T>(questDir: string, fn: () => T): T {
	if (!existsSync(questDir)) {
		throw new Error(`Quest directory ${questDir} does not exist.`);
	}
	const lockPath = join(questDir, LOCK_NAME);
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
	const fd = acquireLock(lockPath);
	try {
		return fn();
	} finally {
		releaseLock(lockPath, fd);
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

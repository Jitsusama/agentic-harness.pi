/**
 * An advisory lock around one file's read-modify-write, for async
 * callers.
 *
 * A read-modify-write that two writers run at once loses one of them:
 * both read the same document and the second write lays its version
 * over the first. Two layers stop that. Within a process, writers of
 * one path queue behind each other, so parallel tool calls in one
 * session never contend. Across processes, a lock file created with
 * `wx` holds the holder's pid, and the next writer waits for it.
 *
 * The synchronous counterpart for quest READMEs is in
 * `quest/io.ts`; its callers cannot await, so it spins instead.
 *
 * A lock is taken over when its holder has gone or it is older than
 * any real write takes, since a crashed session must not wedge the
 * file for good and a pid can be reused. Taking over renames the lock
 * aside rather than deleting it, and checks the file it moved is the
 * one it judged stale: between that judgement and the move, another
 * writer may have taken over first and made a fresh one, and deleting
 * by name would delete theirs. Release checks the same way, so a
 * holder that was taken over from does not delete its successor's.
 *
 * The wait for a live holder is timed per holder, told by the lock
 * file's inode and time, since a lock that changes hands is a line that moves
 * rather than one writer that stopped. On 24 November about 70 rounds
 * waiting on the council line each took it every 15 seconds, and one
 * that lost to them for 10 seconds was told one process held it.
 */

import { randomUUID } from "node:crypto";
import { link, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { processGlobal } from "../../internal/process/process-global.ts";

/** How long a writer waits for one live holder before saying so. */
const WAIT_MS = 10_000;
/**
 * How long a writer waits on a lock that keeps changing hands before
 * saying the line is too busy to let it in.
 */
const BUSY_MS = 120_000;
/** Pause between attempts at the lock. */
const RETRY_MS = 20;
/**
 * A lock older than this is taken over whoever holds it. A write under
 * it is a read and a rename of a small file, milliseconds, so anything
 * this old is a holder that stopped rather than one still writing.
 */
const STALE_MS = 30_000;

/** The code a live holder keeping the lock past {@link WAIT_MS} throws with. */
const LOCK_HELD = "ELOCKHELD";

/**
 * A live holder kept the lock past {@link WAIT_MS}, so nothing was
 * written and nothing else went wrong: a caller may give up on what it
 * was writing for and go on with the rest.
 */
class LockHeld extends Error {
	/** Read by {@link isLockHeld}, since another copy of this module has another class. */
	readonly code = LOCK_HELD;
}

/**
 * What a live holder keeping `lockPath` past the wait is said as, `holder`
 * its pid when it wrote one. One place, so a reader that counts these, as
 * the sweep's log does, reads the words a lock really says.
 */
export function lockHeldMessage(
	lockPath: string,
	holder: number | undefined,
): string {
	return `${lockPath} has been held for over ${WAIT_MS / 1000}s by ${holder === undefined ? "a process that did not say which" : `pid ${holder}`}, which is still running. Nothing was written. If that process is not writing, delete the lock file and try again.`;
}

/**
 * What a lock too busy to let this writer in is said as: no holder kept
 * it long, but `hands` others took it in turn for {@link BUSY_MS}.
 */
function lockBusyMessage(lockPath: string, hands: number): string {
	return `${lockPath} changed hands ${hands} times in ${BUSY_MS / 1000}s without this writer getting a turn, so many processes are writing it at once. Nothing was written; try again once fewer are.`;
}

/**
 * Whether an error is a live holder keeping the lock past the wait,
 * rather than the lock's folder or the writer failing. Told by its code,
 * so an error from any copy of this module counts.
 */
export function isLockHeld(error: unknown): boolean {
	return hasCode(error, LOCK_HELD);
}

/**
 * The writers waiting on each path, one queue for the whole process. Pi
 * loads a fresh copy of this module for each extension, and a host for
 * each folder its conversations run in, all under one pid: with a queue
 * per copy, a second copy would find a lock naming this pid and, as
 * {@link isAlive} must, judge it left by a process gone, and take it
 * from its live holder.
 */
const queues = processGlobal(
	"agentic-harness.file-lock.queues.v1",
	() => new Map<string, Promise<unknown>>(),
);

/**
 * Run `fn` while holding the lock for `path`, queued behind any other
 * writer of the same path in this process and locked against every
 * other process. The lock file is `${path}.lock`, so its directory has
 * to exist.
 */
export async function withFileLock<T>(
	path: string,
	fn: () => Promise<T>,
): Promise<T> {
	const before = queues.get(path) ?? Promise.resolve();
	const turn = before.then(
		() => locked(path, fn),
		() => locked(path, fn),
	);
	// The queue only orders writers; it never carries a failure from one
	// to the next, so the entry it holds settles either way.
	const settled = turn.then(
		() => undefined,
		() => undefined,
	);
	queues.set(path, settled);
	try {
		return await turn;
	} finally {
		if (queues.get(path) === settled) queues.delete(path);
	}
}

async function locked<T>(path: string, fn: () => Promise<T>): Promise<T> {
	const lockPath = `${path}.lock`;
	const held = await acquire(lockPath);
	try {
		return await fn();
	} finally {
		await release(lockPath, held);
	}
}

async function acquire(lockPath: string): Promise<number> {
	const busyUntil = Date.now() + BUSY_MS;
	let holder: { readonly is: string; readonly until: number } | undefined;
	let hands = 0;
	while (true) {
		try {
			const handle = await open(lockPath, "wx");
			try {
				await handle.writeFile(String(process.pid), "utf8");
				return (await handle.stat()).ino;
			} finally {
				await handle.close();
			}
		} catch (error) {
			if (!hasCode(error, "EEXIST")) throw error;
		}
		const live = await takeOverIfStale(lockPath);
		if (live === undefined) continue;
		const now = Date.now();
		if (holder?.is !== live) {
			if (holder !== undefined) hands += 1;
			holder = { is: live, until: now + WAIT_MS };
		}
		if (now >= holder.until) {
			throw new LockHeld(lockHeldMessage(lockPath, await holderOf(lockPath)));
		}
		if (now >= busyUntil) throw new LockHeld(lockBusyMessage(lockPath, hands));
		await new Promise((done) => setTimeout(done, RETRY_MS));
	}
}

/**
 * Takes over the lock if its holder has gone or it is stale, answering
 * nothing when the writer should try again at once, or which live lock
 * it must wait for: its inode and when it was made, since a holder's
 * successor may be given the inode it freed.
 */
async function takeOverIfStale(lockPath: string): Promise<string | undefined> {
	let judged: Awaited<ReturnType<typeof stat>>;
	try {
		judged = await stat(lockPath);
	} catch (error) {
		// Released between the failed create and here: try again.
		if (hasCode(error, "ENOENT")) return undefined;
		throw error;
	}
	const holder = await holderOf(lockPath);
	const old = Date.now() - judged.mtimeMs > STALE_MS;
	// A holder that has not written its pid yet is one mid-create, not
	// one that has gone, so only age can make its lock stale.
	const gone = holder !== undefined && !isAlive(holder);
	if (!old && !gone) return `${judged.ino}@${judged.mtimeMs}`;

	const aside = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
	try {
		await rename(lockPath, aside);
	} catch (error) {
		// Somebody else took it over first.
		if (hasCode(error, "ENOENT")) return undefined;
		throw error;
	}
	const moved = await stat(aside);
	if (moved.ino !== judged.ino) {
		// Between the judgement and the move another writer took over and
		// made a fresh lock, and this moved theirs. Put it back, unless a
		// third has already made one, in which case theirs stands and the
		// one moved is left for its holder's release to find missing.
		try {
			await link(aside, lockPath);
		} catch (error) {
			if (!hasCode(error, "EEXIST")) throw error;
		}
	}
	await unlink(aside);
	return undefined;
}

async function release(lockPath: string, ino: number): Promise<void> {
	try {
		if ((await stat(lockPath)).ino === ino) await unlink(lockPath);
	} catch (error) {
		// Taken over and released by somebody else already: nothing of
		// this holder's is left to remove.
		if (!hasCode(error, "ENOENT")) throw error;
	}
}

async function holderOf(lockPath: string): Promise<number | undefined> {
	try {
		const pid = Number.parseInt(await readFile(lockPath, "utf8"), 10);
		return Number.isFinite(pid) && pid > 0 ? pid : undefined;
	} catch (error) {
		// Gone since the create failed, which the next attempt handles.
		if (hasCode(error, "ENOENT")) return undefined;
		throw error;
	}
}

function isAlive(pid: number): boolean {
	// This process never waits on its own lock, since all its writers, in
	// every copy of this module, queue first, so a lock naming it is one a
	// previous process with the same pid left behind.
	if (pid === process.pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM is a process that exists and belongs to somebody else.
		return hasCode(error, "EPERM");
	}
}

function hasCode(error: unknown, code: string): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === code
	);
}

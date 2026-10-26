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
 */

import { randomUUID } from "node:crypto";
import { link, open, readFile, rename, stat, unlink } from "node:fs/promises";

/** How long a writer waits for a live holder before saying so. */
const WAIT_MS = 10_000;
/** Pause between attempts at the lock. */
const RETRY_MS = 20;
/**
 * A lock older than this is taken over whoever holds it. A write under
 * it is a read and a rename of a small file, milliseconds, so anything
 * this old is a holder that stopped rather than one still writing.
 */
const STALE_MS = 30_000;

const queues = new Map<string, Promise<unknown>>();

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
	const deadline = Date.now() + WAIT_MS;
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
		if (await takeOverIfStale(lockPath)) continue;
		if (Date.now() >= deadline) {
			const holder = await holderOf(lockPath);
			throw new Error(
				`${lockPath} has been held for over ${WAIT_MS / 1000}s by ${holder === undefined ? "a process that did not say which" : `pid ${holder}`}, which is still running. Nothing was written. If that process is not writing, delete the lock file and try again.`,
			);
		}
		await new Promise((done) => setTimeout(done, RETRY_MS));
	}
}

async function takeOverIfStale(lockPath: string): Promise<boolean> {
	let judged: Awaited<ReturnType<typeof stat>>;
	try {
		judged = await stat(lockPath);
	} catch (error) {
		// Released between the failed create and here: try again.
		if (hasCode(error, "ENOENT")) return true;
		throw error;
	}
	const holder = await holderOf(lockPath);
	const old = Date.now() - judged.mtimeMs > STALE_MS;
	// A holder that has not written its pid yet is one mid-create, not
	// one that has gone, so only age can make its lock stale.
	const gone = holder !== undefined && !isAlive(holder);
	if (!old && !gone) return false;

	const aside = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
	try {
		await rename(lockPath, aside);
	} catch (error) {
		// Somebody else took it over first.
		if (hasCode(error, "ENOENT")) return true;
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
	return true;
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
	// This process never waits on its own lock, since its writers queue
	// first, so a lock naming it is one a previous process with the same
	// pid left behind.
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

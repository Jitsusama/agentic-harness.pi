/**
 * The one lock every sweep of a machine's trees takes, so two never
 * judge the same trees at once.
 *
 * It is a file holding its holder's pid. A second sweep has nothing to
 * add to the first, so it never waits: it answers why it can't run. A
 * running sweep touches its lock every {@link LOCK_FRESH_EVERY_MS}, so
 * one left behind, by its holder ending or by standing untouched past
 * {@link SWEEP_STALE_MS}, is a sweep that stopped: it is moved aside and
 * taken over, so a sweep cut off mid-run never stops the next.
 *
 * A sweep knows its own lock by the file, not by the pid in it, since a
 * host's conversations share one pid. The text stays a bare pid, so a
 * session still running code from before the touching came in reads a
 * running sweep's lock as held, rather than as nobody's.
 */

import { randomBytes } from "node:crypto";
import {
	closeSync,
	fstatSync,
	linkSync,
	lstatSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	type Stats,
	utimesSync,
	writeSync,
} from "node:fs";

/**
 * How long a sweep's lock may go untouched before it is taken over
 * whoever holds it. A running sweep touches it every
 * {@link LOCK_FRESH_EVERY_MS}, so one this old has stopped rather than
 * working.
 */
export const SWEEP_STALE_MS = 60 * 60 * 1000;

/**
 * How often a running sweep touches its lock, well inside
 * {@link SWEEP_STALE_MS}. A sweep outgrew the stale age on 19 November,
 * judging 860 kept trees on a loaded machine: at an hour a second sweep
 * took the lock over beside the first, in the same host, doubling the
 * work that had made the first slow. Each minute, so that after a
 * machine wakes from a long sleep its running sweep's lock reads stale
 * for at most a minute.
 */
export const LOCK_FRESH_EVERY_MS = 60 * 1000;

/**
 * How long a sweep keeps touching its lock, counted in time the machine
 * was awake, so a sleep never ends it early. A sweep wedged on an answer
 * that never comes stops touching it this long after it began, and the
 * lock goes stale {@link SWEEP_STALE_MS} after its last touch, about six
 * hours in, so another sweep can run.
 */
export const LOCK_FRESH_FOR_MS = 5 * 60 * 60 * 1000;

/** How often, and for how long, a running sweep touches its lock. */
export interface LockFresh {
	/** Milliseconds between touches. */
	everyMs: number;
	/** Awake milliseconds after the sweep began that it stops touching. */
	forMs: number;
}

/**
 * Hold the sweep's lock, answering how to let it go, or why another
 * sweep has it. While held the lock is touched as `fresh` says. A lock
 * whose holder has ended, or that has stood untouched past
 * {@link SWEEP_STALE_MS}, is moved aside and taken over. Unlike the
 * record locks this never waits: a second sweep has nothing to add.
 */
export function sweepLock(
	lockPath: string,
	fresh: LockFresh = {
		everyMs: LOCK_FRESH_EVERY_MS,
		forMs: LOCK_FRESH_FOR_MS,
	},
): (() => void) | string {
	for (let tries = 0; tries < 2; tries += 1) {
		let mine: string;
		try {
			const fd = openSync(lockPath, "wx");
			try {
				writeSync(fd, String(process.pid));
				mine = identity(fstatSync(fd));
			} finally {
				closeSync(fd);
			}
		} catch (error) {
			if (!hasCode(error, "EEXIST")) throw error;
			const held = heldBy(lockPath);
			if (held !== undefined) return held;
			continue;
		}
		return keptFresh(lockPath, mine, fresh);
	}
	return "another sweep took the lock as this one did";
}

/**
 * Touch our lock while it is still ours, until `fresh.forMs` of awake
 * time has gone, answering how to let it go. Only our own lock is
 * touched or removed: one taken over from us is its new holder's.
 */
function keptFresh(
	lockPath: string,
	mine: string,
	fresh: LockFresh,
): () => void {
	// The monotonic clock stands still while the machine sleeps, so a
	// night's suspend neither spends the budget nor ends it at the wake.
	const began = performance.now();
	const beat = setInterval(() => {
		if (performance.now() - began > fresh.forMs) clearInterval(beat);
		else if (identityOf(lockPath) === mine) touch(lockPath);
	}, fresh.everyMs);
	// A sweep's touching must never keep its process alive.
	beat.unref();
	return () => {
		clearInterval(beat);
		if (identityOf(lockPath) === mine) rmSync(lockPath, { force: true });
	};
}

/**
 * Why the lock at `lockPath` stands in the way, or undefined once it no
 * longer does: gone, or left behind and now moved aside. A lock naming
 * no pid, as one just made and not yet written is, goes only by its age.
 */
function heldBy(lockPath: string): string | undefined {
	let judged: Stats;
	try {
		// The link itself, never what it points at: a dangling link at the
		// lock's path is judged by its age and moved aside like a lock.
		judged = lstatSync(lockPath);
	} catch (error) {
		// Let go between the failed create and here: try again.
		if (hasCode(error, "ENOENT")) return undefined;
		throw error;
	}
	const holder = holderOf(lockPath);
	const stale = Date.now() - judged.mtimeMs > SWEEP_STALE_MS;
	const gone = holder !== undefined && !isAlive(holder);
	if (!stale && !gone) {
		return holder === undefined
			? "another sweep is starting"
			: `another sweep is running, pid ${holder}`;
	}
	const aside = `${lockPath}.stale-${process.pid}-${randomBytes(4).toString("hex")}`;
	try {
		renameSync(lockPath, aside);
	} catch (error) {
		// Somebody else moved it first, which is theirs to hold now.
		if (hasCode(error, "ENOENT")) return undefined;
		throw error;
	}
	if (identity(lstatSync(aside)) !== identity(judged)) {
		// Between the judgement and the move another sweep took the lock
		// over and made its own, and this moved theirs. Put it back,
		// unless a third has already made one, which then stands.
		try {
			linkSync(aside, lockPath);
		} catch (error) {
			if (!hasCode(error, "EEXIST")) throw error;
		}
	}
	rmSync(aside, { force: true });
	return undefined;
}

/**
 * Which file a lock is, whatever it holds: its device and inode, as the
 * record locks know theirs. Not its birth time, which some file systems
 * move when a file's times are set and others don't keep, so a sweep
 * would stop knowing its own lock. A removed lock's inode can name the
 * next one made, but only once this one is gone, when it holds nothing.
 */
function identity(stats: Stats): string {
	return `${stats.dev}/${stats.ino}`;
}

function identityOf(lockPath: string): string | undefined {
	try {
		return identity(lstatSync(lockPath));
	} catch {
		// Gone: no lock, so none of ours.
		return undefined;
	}
}

function touch(lockPath: string): void {
	try {
		const now = new Date();
		utimesSync(lockPath, now, now);
	} catch {
		// Gone since it was read: nothing left to keep fresh.
	}
}

function holderOf(lockPath: string): number | undefined {
	try {
		const pid = Number(readFileSync(lockPath, "utf8").trim());
		return Number.isInteger(pid) && pid > 0 ? pid : undefined;
	} catch {
		// Gone or half-written: nobody this can name holds it.
		return undefined;
	}
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
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

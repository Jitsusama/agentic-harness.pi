/**
 * The one lock every sweep of a machine's trees takes, so two never
 * judge the same trees at once.
 *
 * It is a file holding its holder's pid. A second sweep has nothing to
 * add to the first, so it never waits: it answers why it can't run. A
 * lock its holder left behind, by ending or by standing past
 * {@link SWEEP_STALE_MS}, is moved aside and taken over, so a sweep cut
 * off mid-run never stops the next.
 */

import { randomBytes } from "node:crypto";
import {
	closeSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeSync,
} from "node:fs";

/**
 * How old a sweep's lock may be before it is taken over whoever holds
 * it: past any real sweep, so its holder stopped rather than working.
 */
const SWEEP_STALE_MS = 60 * 60 * 1000;

/**
 * Hold the sweep's lock, answering how to let it go, or why another
 * sweep has it. A lock whose holder has ended, or that has stood past
 * {@link SWEEP_STALE_MS}, is moved aside and taken over. Unlike the
 * record locks this never waits: a second sweep has nothing to add.
 */
export function sweepLock(lockPath: string): (() => void) | string {
	for (let tries = 0; tries < 2; tries += 1) {
		try {
			const fd = openSync(lockPath, "wx");
			try {
				writeSync(fd, String(process.pid));
			} finally {
				closeSync(fd);
			}
			return () => {
				// Only our own lock: one taken over from us is its new holder's.
				if (holderOf(lockPath) === process.pid)
					rmSync(lockPath, { force: true });
			};
		} catch (error) {
			if (!hasCode(error, "EEXIST")) throw error;
		}
		const holder = holderOf(lockPath);
		if (holder !== undefined && isAlive(holder) && !isStale(lockPath)) {
			return `another sweep is running, pid ${holder}`;
		}
		const stale = `${lockPath}.stale-${process.pid}-${randomBytes(4).toString("hex")}`;
		try {
			renameSync(lockPath, stale);
			rmSync(stale, { force: true });
		} catch (error) {
			// Somebody else moved it first, which is theirs to hold now.
			if (!hasCode(error, "ENOENT")) throw error;
		}
	}
	return "another sweep took the lock as this one did";
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

function isStale(lockPath: string): boolean {
	try {
		return Date.now() - statSync(lockPath).mtimeMs > SWEEP_STALE_MS;
	} catch {
		// Gone since it was read, so nothing stands in the way.
		return true;
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

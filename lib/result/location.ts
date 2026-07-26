/**
 * Where a session's stored payloads live, and when they stop
 * living there.
 *
 * Keyed by process id, because that is the one identifier that is
 * both available everywhere without being passed around and
 * checkable from outside: a directory named for a process that no
 * longer exists is abandoned, and no bookkeeping had to survive
 * the crash to tell us so. Sessions that end cleanly delete their
 * own directory; sessions that are killed leave one behind, and
 * the next session to start reaps it.
 *
 * The alternative, reaping by age, cannot tell a dead session's
 * payloads from a live session's, so it either deletes payloads
 * somebody is still querying or keeps payloads nobody can.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Where every session's stored payloads are rooted. */
export const RESULT_ROOT = path.join(os.tmpdir(), "pi-tool-results");

/** Stored payloads are private to the user who made them. */
const DIR_MODE = 0o700;

/**
 * How much disk one session's payloads may hold.
 *
 * Generous, because the point of storing is that the caller can
 * come back for detail later in a long session, and a quota that
 * evicts a page outline before it has been queried has cost the
 * context it was meant to save.
 */
export const SESSION_QUOTA_BYTES = 256 * 1024 * 1024;

/** This process's own payload directory. */
export function sessionResultDir(): string {
	return path.join(RESULT_ROOT, String(process.pid));
}

/** Create this session's payload directory if it is not there. */
export function ensureSessionResultDir(): string {
	const dir = sessionResultDir();
	fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
	return dir;
}

/** Whether a process is still running. */
export function isPidAlive(pid: number): boolean {
	try {
		// Signal 0 tests for the process without touching it.
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM means it exists and belongs to somebody else, which is
		// still alive as far as reaping is concerned.
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Remove payload directories no live process owns.
 *
 * The collaborators are parameters so a destructive sweep can be
 * tested against a throwaway root rather than the real one.
 */
export function reapAbandonedResults(opts: {
	root: string;
	isPidAlive: (pid: number) => boolean;
}): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(opts.root, { withFileTypes: true });
	} catch {
		// No root yet, so nothing was ever abandoned.
		return;
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const pid = Number(entry.name);
		// Anything not named for a pid was not made by us; leaving it
		// alone is cheaper than being wrong about whose it is.
		if (!Number.isInteger(pid) || pid <= 0) continue;
		if (opts.isPidAlive(pid)) continue;
		try {
			fs.rmSync(path.join(opts.root, entry.name), {
				recursive: true,
				force: true,
			});
		} catch {
			// It vanished under us or will not delete; either way the next
			// session will try again.
		}
	}
}

/** Remove this session's payload directory. */
export function cleanupSessionResults(): void {
	try {
		fs.rmSync(sessionResultDir(), { recursive: true, force: true });
	} catch {
		// Nothing more can be done at shutdown, and the pid-keyed name
		// means the next session's reaper will collect it.
	}
}

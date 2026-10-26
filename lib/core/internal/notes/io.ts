/**
 * Atomic file writes for note READMEs.
 *
 * The "read text, parse, mutate, write text" sequence every
 * mutating verb runs is not atomic against a concurrent
 * reader on a slow disk: a naive write can leave a reader
 * seeing half a file. We write to a sibling temp file, fsync,
 * then rename over the target, so an observer always sees
 * the old or the new file in full -- the same pattern quest
 * uses (`internal/quest/io.ts`).
 *
 * Unlike quest, there is no cross-process lock here. Quest
 * needs one because two pi sessions can legitimately attach
 * to and mutate the same quest concurrently; a notes archive
 * has no equivalent multi-writer scenario -- it's a single
 * user's single-writer CLI. If that ever changes, port
 * quest's `withQuestLock` rather than inventing a new one.
 */

import {
	closeSync,
	fsyncSync,
	openSync,
	renameSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

/**
 * Write `data` to `path` atomically: write to a sibling temp
 * file in the same directory, fsync, then rename. The rename
 * is atomic on POSIX filesystems for files on the same
 * volume, which a sibling temp file always is.
 */
export function atomicWriteFile(path: string, data: string): void {
	const dir = dirname(path);
	const tmp = join(
		dir,
		`.${path.split("/").pop()}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
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

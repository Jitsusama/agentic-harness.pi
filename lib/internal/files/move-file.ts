/**
 * Moving a file or a link to another path whole: by rename where both
 * lie on one volume, and else by a copy beside its new place, synced,
 * renamed in, its folder synced so the new name outlasts a crash, and
 * the original then removed. On the Mac a sync reaches only the drive's
 * own cache, since Node has no F_FULLFSYNC, so a power cut there can
 * still lose a copy just made.
 *
 * A btrfs subvolume answers a rename from outside it with EXDEV though
 * the disk is the same, and each quest's scratch is a subvolume of its
 * own. The copy never follows a link: a link at the path moved moves as
 * a link, and nothing it points at is read. It is written under a name
 * made only now and refused where anything stands, so nothing planted
 * beside the new place is written through; and since it is renamed in,
 * whoever reads the new place finds the old file or the whole new one.
 * The original is removed only while its path still names the file
 * copied, since a copy lasts as long as the file is long, and a folder on
 * its way swapped for a link meanwhile would have it remove another.
 * A copy takes no more room than the file had when opened, never more
 * than the caller's ceiling, and never more than its new volume has
 * left, since a fenced command can plant a file that grows as it is
 * read, or a sparse one far larger than the bytes it holds, which a copy
 * writes out whole. A file whose length, modification or change time
 * moved while it was copied isn't moved, though a filesystem that stamps
 * only whole seconds can hide a rewrite within one.
 */

import { randomUUID } from "node:crypto";
import {
	type BigIntStats,
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	openSync,
	readlinkSync,
	readSync,
	renameSync,
	rmSync,
	statfsSync,
	symlinkSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { errnoOf } from "./errno.ts";

/** How much of a file is copied at a time. */
const CHUNK = 1024 * 1024;

/** Opens a source for reading, never through a link nor waiting on a pipe. */
const READ = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** Makes a copy's file only where nothing, not even a link, stands. */
const MAKE =
	constants.O_WRONLY |
	constants.O_CREAT |
	constants.O_EXCL |
	constants.O_NOFOLLOW;

/** The bits of a file's mode its copy keeps: who may read, write and run it. */
const MODE_BITS = 0o777;

/** Opens a folder to sync it, never through a link nor waiting on a pipe. */
const FOLDER =
	constants.O_RDONLY |
	constants.O_DIRECTORY |
	constants.O_NOFOLLOW |
	constants.O_NONBLOCK;

/**
 * Moves the file or link at `from` to `to`, replacing what stands there,
 * so `to` holds either what it held or the whole of `from`. Throws, with
 * `to` as it was, where `from` is a folder or anything but a file or a
 * link on another volume, is longer than `most` bytes or than the room
 * left there, or where the move fails; only a failure to sync its new
 * folder or remove `from` after its copy stands, or `from` naming
 * another file by then, leaves both. A rename takes no room, so `most`
 * bounds only a copy.
 */
export function moveFile(
	from: string,
	to: string,
	most = Number.POSITIVE_INFINITY,
): void {
	try {
		renameSync(from, to);
		return;
	} catch (error) {
		if (errnoOf(error) !== "EXDEV") throw error;
	}
	const beside = join(dirname(to), `.${basename(to)}.moving-${randomUUID()}`);
	let moved: BigIntStats;
	try {
		moved = copied(from, beside, most);
		renameSync(beside, to);
	} catch (error) {
		try {
			rmSync(beside, { force: true });
		} catch {
			// Hidden, so it never crosses; why the move failed matters more.
		}
		throw error;
	}
	syncFolder(dirname(to));
	const now = lstatSync(from, { bigint: true });
	if (now.dev !== moved.dev || now.ino !== moved.ino) {
		throw new Error(
			`${from} names another file than the one copied to ${to}, so it isn't removed.`,
		);
	}
	unlinkSync(from);
}

/**
 * Syncs the folder at `path`, so a name just renamed into it stays.
 * Where its volume can't sync a folder (EINVAL), there is nothing to do.
 * Throws where a link, a pipe or anything but a folder stands there,
 * since a fenced command can swap the folder for one.
 */
function syncFolder(path: string): void {
	const folder = openSync(path, FOLDER);
	try {
		fsyncSync(folder);
	} catch (error) {
		if (errnoOf(error) !== "EINVAL") throw error;
	} finally {
		closeSync(folder);
	}
}

/**
 * Copies the file or link at `from` to `to`, where nothing stands yet,
 * where it holds at most `most` bytes and its new volume has room for
 * them, answering what it copied.
 */
function copied(from: string, to: string, most: number): BigIntStats {
	const found = lstatSync(from, { bigint: true });
	if (found.isSymbolicLink()) {
		symlinkSync(readlinkSync(from), to);
		return found;
	}
	if (!found.isFile()) {
		throw new Error(`${from} isn't a file or a link, so it isn't moved.`);
	}
	const source = openSync(from, READ);
	try {
		// Swapped since the look above for anything but a file, it stays.
		const opened = fstatSync(source, { bigint: true });
		if (!opened.isFile()) {
			throw new Error(`${from} isn't a file or a link, so it isn't moved.`);
		}
		if (Number(opened.size) > most) {
			throw new Error(
				`${from} is ${opened.size} bytes, more than the ${most} a move copies, so it isn't moved.`,
			);
		}
		const volume = statfsSync(dirname(to), { bigint: true });
		if (opened.size > volume.bavail * volume.bsize) {
			throw new Error(
				`${from} is ${opened.size} bytes, more than beside ${to} has room for, so it isn't moved.`,
			);
		}
		const mode = Number(opened.mode) & MODE_BITS;
		const target = openSync(to, MAKE, mode);
		try {
			// Set again, past the umask that clipped it at the open.
			fchmodSync(target, mode);
			if (
				!copyAll(source, target, Number(opened.size)) ||
				changed(opened, fstatSync(source, { bigint: true }))
			) {
				throw new Error(
					`${from} changed while it was copied, so it isn't moved.`,
				);
			}
			fsyncSync(target);
		} finally {
			closeSync(target);
		}
		return opened;
	} finally {
		closeSync(source);
	}
}

/** Whether a file's length, modification or change time moved. */
function changed(before: BigIntStats, after: BigIntStats): boolean {
	return (
		before.size !== after.size ||
		before.mtimeNs !== after.mtimeNs ||
		before.ctimeNs !== after.ctimeNs
	);
}

/**
 * Copies the `size` bytes of the descriptor `source` to `target`,
 * answering whether that was all of it: a source that ends sooner or
 * still has more stops there, copying nothing past `size`.
 */
function copyAll(source: number, target: number, size: number): boolean {
	const buffer = Buffer.allocUnsafe(CHUNK);
	let copied = 0;
	while (copied < size) {
		const read = readSync(
			source,
			buffer,
			0,
			Math.min(CHUNK, size - copied),
			null,
		);
		if (read === 0) return false;
		let written = 0;
		while (written < read) {
			written += writeSync(target, buffer, written, read - written);
		}
		copied += read;
	}
	return readSync(source, buffer, 0, 1, null) === 0;
}

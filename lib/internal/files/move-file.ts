/**
 * Moving a file or a link to another path whole: by rename where both
 * lie on one volume, and else by a copy beside its new place, made
 * durable, renamed in, and the original then removed.
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

/**
 * Moves the file or link at `from` to `to`, replacing what stands there,
 * so `to` holds either what it held or the whole of `from`. Throws, with
 * `to` as it was, where `from` is a folder or anything but a file or a
 * link on another volume, or where the move fails; only a failure to
 * remove `from` after its copy stands, or `from` naming another file by
 * then, leaves both.
 */
export function moveFile(from: string, to: string): void {
	try {
		renameSync(from, to);
		return;
	} catch (error) {
		if (errnoOf(error) !== "EXDEV") throw error;
	}
	const beside = join(dirname(to), `.${basename(to)}.moving-${randomUUID()}`);
	let moved: BigIntStats;
	try {
		moved = copied(from, beside);
		renameSync(beside, to);
	} catch (error) {
		try {
			rmSync(beside, { force: true });
		} catch {
			// Hidden, so it never crosses; why the move failed matters more.
		}
		throw error;
	}
	const now = lstatSync(from, { bigint: true });
	if (now.dev !== moved.dev || now.ino !== moved.ino) {
		throw new Error(
			`${from} names another file than the one copied to ${to}, so it isn't removed.`,
		);
	}
	unlinkSync(from);
}

/**
 * Copies the file or link at `from` to `to`, where nothing stands yet,
 * answering what it copied.
 */
function copied(from: string, to: string): BigIntStats {
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
		const mode = Number(opened.mode) & MODE_BITS;
		const target = openSync(to, MAKE, mode);
		try {
			// Set again, past the umask that clipped it at the open.
			fchmodSync(target, mode);
			copyAll(source, target);
			fsyncSync(target);
		} finally {
			closeSync(target);
		}
		return opened;
	} finally {
		closeSync(source);
	}
}

/** Copies every byte from the descriptor `source` to `target`. */
function copyAll(source: number, target: number): void {
	const buffer = Buffer.allocUnsafe(CHUNK);
	for (;;) {
		const read = readSync(source, buffer, 0, CHUNK, null);
		if (read === 0) return;
		let written = 0;
		while (written < read) {
			written += writeSync(target, buffer, written, read - written);
		}
	}
}

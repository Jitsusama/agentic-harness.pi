/**
 * Reading the small files git keeps for a worktree without a read that
 * can wait for ever.
 *
 * A tree's `.git` file, and so every git file it names, sits at a path
 * whatever ran in the tree could choose. A fifo or a device there turns
 * a plain read into one that never returns, holding the work tool, the
 * sweep and reclaim with it, so these files are opened without waiting
 * and read only once they prove plain. A note written beside git's own,
 * as a replay's, is opened the same way, since a fifo waits on a writer's
 * open as long as on a reader's.
 */

import {
	closeSync,
	constants,
	fstatSync,
	ftruncateSync,
	openSync,
	readSync,
	writeSync,
} from "node:fs";

/** The most of a file of git's that {@link readPlain} reads. */
const PLAIN_LIMIT = 4096;

/**
 * The start of the plain file at `path`, at most `limit` bytes, or
 * nothing when no plain file stands there: none at all, a link, which
 * git never writes, or a fifo, a device or a folder.
 */
export function readPlain(
	path: string,
	limit = PLAIN_LIMIT,
): string | undefined {
	let fd: number;
	try {
		fd = openSync(
			path,
			constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
		);
	} catch {
		// Nothing there to open, or a link.
		return undefined;
	}
	try {
		if (!fstatSync(fd).isFile()) return undefined;
		const buffer = Buffer.alloc(limit);
		return buffer.toString("utf8", 0, readSync(fd, buffer, 0, limit, 0));
	} catch {
		// It went or changed as it was read: nothing plain to say.
		return undefined;
	} finally {
		closeQuietly(fd);
	}
}

/**
 * Write `text` as the whole of the plain file at `path`, answering
 * whether it was written. Nothing is written where something other than
 * a plain file of one name stands: a link of either kind, since a hard
 * link planted at a note's name would have the file it shares rewritten,
 * a fifo, a device or a folder. A fifo nobody reads is refused at its
 * open rather than waited on.
 */
export function writePlain(path: string, text: string): boolean {
	let fd: number;
	try {
		fd = openSync(
			path,
			constants.O_WRONLY |
				constants.O_CREAT |
				constants.O_NONBLOCK |
				constants.O_NOFOLLOW,
			0o644,
		);
	} catch {
		// A link, a fifo with no reader, or no folder to write in.
		return false;
	}
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.nlink !== 1) return false;
		// Cut only once it proves plain, so a fifo opened is never truncated.
		const bytes = Buffer.from(text, "utf8");
		let written = 0;
		while (written < bytes.length) {
			written += writeSync(fd, bytes, written, bytes.length - written, written);
		}
		ftruncateSync(fd, bytes.length);
		return true;
	} catch {
		// It went or changed as it was written: unwritten, as the caller allows.
		return false;
	} finally {
		closeQuietly(fd);
	}
}

/** Close `fd`, which a read has finished with whatever close says. */
function closeQuietly(fd: number): void {
	try {
		closeSync(fd);
	} catch {
		// What was read stands; a failed close loses nothing here.
	}
}

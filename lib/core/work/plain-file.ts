/**
 * Reading the small files git keeps for a worktree without a read that
 * can wait for ever.
 *
 * A tree's `.git` file, and so every git file it names, sits at a path
 * whatever ran in the tree could choose. A fifo or a device there turns
 * a plain read into one that never returns, holding the work tool, the
 * sweep and reclaim with it, so these files are opened without waiting
 * and read only once they prove plain.
 */

import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

/** The most of a file of git's that {@link readPlain} reads. */
const PLAIN_LIMIT = 4096;

/**
 * The start of the plain file at `path`, at most {@link PLAIN_LIMIT}
 * bytes, or nothing when no plain file stands there: none at all, a
 * link, which git never writes, or a fifo, a device or a folder.
 */
export function readPlain(path: string): string | undefined {
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
		const buffer = Buffer.alloc(PLAIN_LIMIT);
		return buffer.toString("utf8", 0, readSync(fd, buffer, 0, PLAIN_LIMIT, 0));
	} catch {
		// It went or changed as it was read: nothing plain to say.
		return undefined;
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

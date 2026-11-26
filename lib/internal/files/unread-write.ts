/**
 * Whether a write would replace a file its conversation never saw.
 *
 * pi's write tool replaces a file whole, read or not. On 25 November a
 * session wrote a state file of asks over the one already there, never
 * having read it, and every ask in it was lost. A file the conversation
 * read, wrote or edited carries the stamp it had then (its inode, size
 * and modification time, as `stamped-read.ts` says a file is the one it
 * was); a write over a file with no stamp, or one whose stamp has moved
 * since, would lose what it holds unseen. A new file, or an empty one,
 * has nothing to lose.
 */

import { statSync } from "node:fs";
import { stampOf } from "./stamped-read.ts";

/** The stamp of the file at `path` now, or nothing where no file is. */
export function stampNow(path: string): string | undefined {
	try {
		const stats = statSync(path);
		return stats.isFile() ? stampOf(stats) : undefined;
	} catch {
		// Gone or never there: a file with no stamp, which nothing saw.
		return undefined;
	}
}

/**
 * Why a write to `path` would lose what the file holds unseen, given the
 * stamp it had when its conversation last read, wrote or edited it, or
 * nothing when the write loses nothing: no file there, or an empty one,
 * or the one the conversation saw.
 */
export function unreadWriteRefusal(
	path: string,
	seen: string | undefined,
): string | undefined {
	let size: number;
	let now: string;
	try {
		const stats = statSync(path);
		if (!stats.isFile()) return undefined;
		size = stats.size;
		now = stampOf(stats);
	} catch {
		// No file there: a write makes it, and loses nothing.
		return undefined;
	}
	if (size === 0 || seen === now) return undefined;
	return seen === undefined
		? `Writing ${path} would replace it whole, and this conversation hasn't read it, so what it holds would be lost unseen. Read it first, or change it with edit.`
		: `${path} has changed since this conversation last read or wrote it, so writing it whole would lose what changed. Read it again first, or change it with edit.`;
}

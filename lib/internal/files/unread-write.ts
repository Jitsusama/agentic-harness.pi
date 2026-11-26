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

import { readFileSync, statSync } from "node:fs";
import { stampOf } from "./stamped-read.ts";

/** The size in bytes a stamp names, its last part. */
export function stampSize(stamp: string): number {
	return Number(stamp.slice(stamp.lastIndexOf(":") + 1));
}

/**
 * Whether the file at `path` holds what a write sent, so nothing that
 * landed between the write and its result is taken as seen.
 */
export function writtenAsSent(path: string, content: unknown): boolean {
	if (typeof content !== "string") return false;
	try {
		return readFileSync(path, "utf8") === content;
	} catch {
		// Gone or unreadable since: nothing the conversation can say it saw.
		return false;
	}
}

/**
 * How many bytes an edit's replacements move a file by, read from its
 * input as pi's edit tool reads it (an array, one edit alone, a JSON
 * string of either, or the older oldText and newText), or nothing where
 * it names none.
 */
export function editDelta(input: unknown): number | undefined {
	if (typeof input !== "object" || input === null) return undefined;
	const edits = [...editsOf("edits" in input ? input.edits : undefined)];
	if ("oldText" in input && "newText" in input) edits.push(input);
	let delta = 0;
	for (const edit of edits) {
		const oldText = "oldText" in edit ? edit.oldText : undefined;
		const newText = "newText" in edit ? edit.newText : undefined;
		if (typeof oldText !== "string" || typeof newText !== "string")
			return undefined;
		delta += Buffer.byteLength(newText) - Buffer.byteLength(oldText);
	}
	return edits.length === 0 ? undefined : delta;
}

/** The replacements an edit's `edits` field names, however it was sent. */
function editsOf(edits: unknown): readonly object[] {
	let named = edits;
	if (typeof named === "string") {
		try {
			named = JSON.parse(named);
		} catch {
			// Not JSON: pi refuses it too, so it names no replacement.
			return [];
		}
	}
	if (Array.isArray(named))
		return named.filter((edit) => typeof edit === "object" && edit !== null);
	return typeof named === "object" && named !== null ? [named] : [];
}

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

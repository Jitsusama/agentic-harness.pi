/**
 * A file's parse kept while the file is the one it was read from, read
 * on the thread or off it.
 *
 * A file published by a rename has a new inode, and one written in
 * place a new mtime or size, so the three together say a change. A file
 * gone is forgotten, so what is kept never outlives what it was read
 * from. What `read` makes of an unreadable file is kept as well, so a
 * torn file is read again only once it changes. Unlike `parsedFiles`
 * (lib/internal/quest/documents/parsed-file.ts), these files are small and their
 * caller says when to forget the rest, so the map is the caller's.
 */

import { statSync } from "node:fs";
import { stat } from "node:fs/promises";

/** A file's parse, and the file it came from, by its stat. */
export interface Stamped<T> {
	readonly stamp: string;
	readonly value: T | undefined;
}

/** What says a file is the one it was: its inode, mtime and size. */
function stampOf(of: {
	readonly ino: number;
	readonly mtimeMs: number;
	readonly size: number;
}): string {
	return `${of.ino}:${of.mtimeMs}:${of.size}`;
}

/**
 * The file at `path` as `read` parses it, kept in `kept` while its stamp
 * stays as it was; a file gone is forgotten.
 */
export function readStamped<T>(
	kept: Map<string, Stamped<T>>,
	path: string,
	read: (path: string) => T | undefined,
): T | undefined {
	let stamp: string;
	try {
		stamp = stampOf(statSync(path));
	} catch {
		// Gone since it was listed, or never there: nothing to read.
		kept.delete(path);
		return undefined;
	}
	const was = kept.get(path);
	if (was?.stamp === stamp) return was.value;
	const value = read(path);
	kept.set(path, { stamp, value });
	return value;
}

/** The file at `path` as `readStamped` keeps it, read off the thread. */
export async function readStampedOff<T>(
	kept: Map<string, Stamped<T>>,
	path: string,
	read: (path: string) => Promise<T | undefined>,
): Promise<T | undefined> {
	let stamp: string;
	try {
		stamp = stampOf(await stat(path));
	} catch {
		// Gone since it was listed, or never there: nothing to read.
		kept.delete(path);
		return undefined;
	}
	const was = kept.get(path);
	if (was?.stamp === stamp) return was.value;
	const value = await read(path);
	kept.set(path, { stamp, value });
	return value;
}

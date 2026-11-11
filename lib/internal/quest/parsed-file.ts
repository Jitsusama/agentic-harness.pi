/**
 * A quest file read and parsed once, and parsed again only once it
 * changes.
 *
 * The quest workflow reads the loaded quest's README, each parent's up
 * the chain for its budget, and the focused document at the end of
 * every turn, and parses their YAML each time: on 10 November that was
 * about 220 ms of main-thread runs of 50 ms or more in ten minutes of
 * one session, almost all of it the YAML parser, for files that had not
 * changed. A file whose size, inode and modification time are what they
 * were when it was parsed holds the same text, so the parse is kept.
 *
 * A modification time is only as fine as the filesystem's clock tick,
 * so a file written in the same tick as it was read could keep its old
 * time. A parse is kept only when the file was last written well before
 * it was read, as git does for its index: a file that changes later
 * then always shows a newer time.
 */

import { readFileSync, statSync } from "node:fs";

/**
 * How long before a read a file must have been written for its parse to
 * be kept: past any filesystem's timestamp granularity, FAT's two
 * seconds with room to spare.
 */
const RACY_MS = 3_000;

interface Kept<T> {
	readonly size: bigint;
	readonly ino: bigint;
	readonly mtimeNs: bigint;
	readonly value: T;
}

/**
 * Files parsed by `parse`, each reusing its last parse while the file is
 * unchanged. Reading one throws as reading the file would. What it
 * answers may be shared with other callers, so it is read, not changed.
 */
export function parsedFiles<T>(
	parse: (text: string) => T,
): (path: string) => T {
	const kept = new Map<string, Kept<T>>();
	return (path) => {
		const stat = statSync(path, { bigint: true });
		const before = kept.get(path);
		if (
			before !== undefined &&
			before.size === stat.size &&
			before.ino === stat.ino &&
			before.mtimeNs === stat.mtimeNs
		) {
			// Only a parse that passed `racy` below was kept: the same text.
			return before.value;
		}
		const value = parse(readFileSync(path, "utf8"));
		const racy = Date.now() - Number(stat.mtimeMs) < RACY_MS;
		if (racy) kept.delete(path);
		else {
			kept.set(path, {
				size: stat.size,
				ino: stat.ino,
				mtimeNs: stat.mtimeNs,
				value,
			});
		}
		return value;
	};
}

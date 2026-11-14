/**
 * What each file in a folder said when this process last read it, so a
 * folder asked at every conversation's start reads only what changed.
 *
 * A host starts every conversation in one process, and each start asked
 * the same ledgers again: the review rounds, 1,636 files, and the
 * fleets, 2,541, were 115 ms and 60 ms of a parked wake on 14 November.
 * A file is taken to be unchanged while its inode, size and modification
 * time are: the ledgers write a new file and rename it over the old, so
 * every write gives a new inode, and size and time catch an edit made in
 * place. Kept on `globalThis`, since a host loads each extension once
 * for each conversation's folder and every copy should find what another
 * read.
 */

import type { Stats } from "node:fs";
import { stat } from "node:fs/promises";
import { processGlobal } from "./process-global.ts";

/** What one file said, and the stamp of the file that said it. */
interface Read<T> {
	readonly ino: number;
	readonly size: number;
	readonly mtimeMs: number;
	readonly said: T;
}

/** What each file in one folder said when last read. */
export interface FileReads<T> {
	/**
	 * The file's stamp, or nothing when it cannot be stamped. Take it
	 * before the read, so a write between the two leaves a stamp the next
	 * ask finds changed.
	 */
	stamp(path: string): Promise<Stats | undefined>;
	/** What the file said, while it is still the one `seen` stamps. */
	held(path: string, seen: Stats | undefined): { said: T } | undefined;
	/** Keep what the file said, when it was stamped before the read. */
	keep(path: string, seen: Stats | undefined, said: T): void;
	/** Forget every file but those `listed`, as a listing found them. */
	keepOnly(listed: ReadonlySet<string>): void;
}

/**
 * The reads this process keeps of `folder`, under `name`, which says
 * what each read holds: two callers reading one folder for different
 * things keep different reads.
 */
export function fileReads<T>(name: string, folder: string): FileReads<T> {
	const folders = processGlobal(
		`agentic-harness.file-reads.${name}`,
		() => new Map<string, Map<string, Read<T>>>(),
	);
	const reads = folders.get(folder) ?? new Map<string, Read<T>>();
	folders.set(folder, reads);
	return {
		// A file that won't stamp is read as it always was, and its read
		// isn't kept, so the read says what went wrong.
		stamp: (path) => stat(path).catch(() => undefined),
		held(path, seen) {
			const read = reads.get(path);
			if (seen === undefined || read === undefined) return undefined;
			const same =
				read.ino === seen.ino &&
				read.size === seen.size &&
				read.mtimeMs === seen.mtimeMs;
			return same ? { said: read.said } : undefined;
		},
		keep(path, seen, said) {
			if (seen === undefined) return;
			const { ino, size, mtimeMs } = seen;
			reads.set(path, { ino, size, mtimeMs, said });
		},
		keepOnly(listed) {
			for (const path of reads.keys()) {
				if (!listed.has(path)) reads.delete(path);
			}
		},
	};
}

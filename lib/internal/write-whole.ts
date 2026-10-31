/**
 * Writing a file whole, so a reader never sees half of it, without
 * waking whoever watches its folder more than once.
 *
 * The file is written in a `.writing` subfolder beside it and renamed
 * into place. The rename stays atomic, since both are on one
 * filesystem, and a watcher of the folder (the shell watches the
 * mesh's presence and the machine queue's folder) hears one event a
 * write instead of the three or four a temp file made, written and
 * renamed beside it gives: inotify watches don't reach into
 * subfolders.
 */

import { randomBytes } from "node:crypto";
import {
	mkdirSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

/** The subfolder a file is written in before it is renamed into place. */
export const WRITING = ".writing";

/** Replace `file` whole with `content`, through its folder's `.writing`. */
export function writeWhole(file: string, content: string): void {
	const writing = join(dirname(file), WRITING);
	mkdirSync(writing, { recursive: true });
	const staged = join(
		writing,
		`${basename(file)}.${process.pid}.${randomBytes(4).toString("hex")}`,
	);
	try {
		writeFileSync(staged, content);
		renameSync(staged, file);
	} catch (error) {
		rmSync(staged, { force: true });
		throw error;
	}
}

/**
 * Take away what a writer left in `dir`'s `.writing` and last touched
 * before this time: one that died between writing and renaming leaves
 * a file there, and nothing else ever would.
 */
export function clearWriting(dir: string, before: number): void {
	const writing = join(dir, WRITING);
	let names: string[] = [];
	try {
		names = readdirSync(writing);
	} catch {
		return;
	}
	for (const name of names) {
		const staged = join(writing, name);
		try {
			if (statSync(staged).mtimeMs < before) rmSync(staged, { force: true });
		} catch {
			// Renamed into place, or taken by another sweep, as it was looked at.
		}
	}
}

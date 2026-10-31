/**
 * Writing a file whole, so a reader never sees half of it, without
 * waking whoever watches its folder more than once.
 *
 * The file is written in a `.writing` subfolder beside it and renamed
 * into place. The rename stays atomic, since both are on one
 * filesystem, and a watcher of the folder (the shell watches the
 * mesh's presence, the machine queue's folder and the quest folders
 * with something waiting on Joel) hears one event a write instead of
 * the three or four a temp file made, written and renamed beside it
 * gives: inotify watches don't reach into subfolders.
 */

import { randomBytes } from "node:crypto";
import {
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

/** The subfolder a file is written in before it is renamed into place. */
export const WRITING = ".writing";

/** How a file is written whole. */
export interface WriteWholeOptions {
	/**
	 * Flush the content to the disk before it is renamed into place, so
	 * a power cut leaves the old file or the new one, never an empty one.
	 * Records a person keeps (a quest's README) ask for it; state that is
	 * written again within seconds does not.
	 */
	readonly durable?: boolean;
}

/** Replace `file` whole with `content`, through its folder's `.writing`. */
export function writeWhole(
	file: string,
	content: string,
	options: WriteWholeOptions = {},
): void {
	const writing = join(dirname(file), WRITING);
	mkdirSync(writing, { recursive: true });
	const staged = join(
		writing,
		`${basename(file)}.${process.pid}.${randomBytes(4).toString("hex")}`,
	);
	try {
		if (options.durable) writeDurably(staged, content);
		else writeFileSync(staged, content);
		renameSync(staged, file);
	} catch (error) {
		rmSync(staged, { force: true });
		throw error;
	}
}

function writeDurably(path: string, content: string): void {
	const fd = openSync(path, "w");
	try {
		writeSync(fd, content);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
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

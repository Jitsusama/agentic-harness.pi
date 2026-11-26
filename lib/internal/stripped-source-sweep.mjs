/**
 * How long the stripped-source cache keeps what it kept: a hit marks an
 * entry read again once a day has passed, and a start's sweep removes
 * the folders of installs no longer on the disk, those of its own
 * install under another node once none of their entries has been read
 * for two days, folders that name no install an hour after they were
 * made, and the entries of its own folder no start has read for 30
 * days. stripped-source.mjs, which reads and writes the entries, starts
 * it.
 *
 * Plain `.mjs`, as stripped-source.mjs is, since it runs before node
 * loads any of this package's TypeScript.
 */

import { readdir, readFile, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";

/** The file in an install's folder naming the install and node it serves. */
export const ROOT_FILE = "root";

/**
 * How old a folder naming no install must be before a sweep takes it:
 * a start makes its folder, then names its install in it.
 */
const UNNAMED_GRACE_MS = 60 * 60 * 1000;

/** How long since an entry was last read before a hit marks it read again. */
const TOUCH_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * How long none of the entries in its own install's folder under another
 * node must have been marked read before a sweep takes it: a read marks
 * an entry only once it is a day old, so its last read may come a day
 * after its mark, and three days since the newest mark leaves at least
 * the two days since the last read that the header promises.
 */
const OTHER_NODE_IDLE_MS = 3 * TOUCH_AFTER_MS;

/** How long an entry no start has read is kept. */
const ENTRY_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Mark the entry `file` read now when it was last marked over a day
 * ago, so the sweep keeps what starts still read.
 *
 * @param {string} file
 * @param {number} now
 * @returns {Promise<void>}
 */
export async function touchIfOld(file, now = Date.now()) {
	try {
		const seen = await stat(file);
		if (now - seen.mtimeMs <= TOUCH_AFTER_MS) return;
		const at = now / 1000;
		await utimes(file, at, at);
	} catch {
		// Swept meanwhile: a later start strips it again.
	}
}

/**
 * Whether something stands at `path`: only a path that is missing, or
 * runs through a file, counts as gone, so one that can't be looked at
 * now is left for a later sweep.
 *
 * @param {string} path
 * @returns {Promise<boolean>}
 */
async function stands(path) {
	if (!path) return false;
	try {
		await stat(path);
		return true;
	} catch (error) {
		const code =
			error instanceof Error && "code" in error ? error.code : undefined;
		return code !== "ENOENT" && code !== "ENOTDIR";
	}
}

/**
 * Remove the entries in `folder` no start has read for 30 days.
 *
 * @param {string} folder
 * @param {number} now
 * @returns {Promise<void>}
 */
async function pruneEntries(folder, now) {
	for (const name of await readdir(folder)) {
		if (name === ROOT_FILE) continue;
		const file = join(folder, name);
		try {
			if (now - (await stat(file)).mtimeMs > ENTRY_LIFE_MS)
				await rm(file, { force: true });
		} catch {
			// Gone meanwhile, or not to be looked at: left for later.
		}
	}
}

/**
 * When anything in `folder` was last written or marked read: the
 * folder's own time and each of its files'.
 *
 * @param {string} folder
 * @returns {Promise<number>}
 */
async function lastUsed(folder) {
	let last = (await stat(folder)).mtimeMs;
	for (const name of await readdir(folder))
		try {
			last = Math.max(last, (await stat(join(folder, name))).mtimeMs);
		} catch {
			// Gone meanwhile: it marks no use.
		}
	return last;
}

/**
 * Remove the folders in `root` but `keep` whose install is gone from
 * the disk, that hold `served` under a node other than `version` and
 * none of whose entries was read for two days, or that name none an
 * hour after they were made; and the entries in `keep` no start has
 * read for 30 days.
 *
 * @type {typeof import("./stripped-source.d.mts").sweepGone}
 */
export async function sweepGone({
	root,
	keep,
	served,
	version,
	now = Date.now(),
}) {
	/** @type {string[]} */
	let names;
	try {
		names = await readdir(root);
	} catch {
		// No folder yet: nothing kept to sweep.
		return;
	}
	for (const name of names) {
		const folder = join(root, name);
		try {
			if (name === keep) {
				await pruneEntries(folder, now);
				continue;
			}
			const named = await readFile(join(folder, ROOT_FILE), "utf8").catch(
				() => undefined,
			);
			let gone;
			if (named === undefined)
				gone = now - (await stat(folder)).mtimeMs > UNNAMED_GRACE_MS;
			else {
				const [install = "", ranOn] = named.split("\n");
				gone =
					(install === served &&
						ranOn !== version &&
						now - (await lastUsed(folder)) > OTHER_NODE_IDLE_MS) ||
					!(await stands(install));
			}
			if (gone) await rm(folder, { recursive: true, force: true });
		} catch {
			// Another start swept it first, or it can't be read: left for later.
		}
	}
}

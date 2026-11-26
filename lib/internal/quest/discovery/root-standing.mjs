/**
 * How a quests root that won't list stands, read the one way both a
 * signing's thread (tree-read.mjs) and the host's own thread
 * (discovery-reads.ts) read it, so the two never disagree on it.
 *
 * Plain `.mjs` because node runs tree-read.mjs directly as a thread,
 * from where consumers install this package, and won't strip types
 * there.
 */

import { lstatSync, statSync } from "node:fs";
import { dirname, normalize, sep } from "node:path";

/** @typedef {"gone" | "unreadable"} RootStanding */

/**
 * "gone" when nothing is at the root nor along it, as a fresh data
 * folder's root is before its first quest (an empty store);
 * "unreadable" when something is: a dangling link at it or above it, a
 * file, a folder that can't be listed, a file where a folder above
 * should be, or a folder above that can't be searched (a fault).
 *
 * lstat follows every link but the last, so a link above that points
 * at nothing (a data folder on a volume not mounted) answers ENOENT as
 * a missing folder does. The nearest part of the path that is there
 * tells them apart: a link that leads nowhere is a store gone offline,
 * not one never made. A trailing slash is dropped first, since it
 * would have lstat follow a link at the root itself.
 *
 * @param {string} path
 * @returns {RootStanding}
 */
export function rootStanding(path) {
	const root = withoutTrailingSlash(normalize(path));
	try {
		lstatSync(root);
		return "unreadable";
	} catch (error) {
		if (codeOf(error) !== "ENOENT") return "unreadable";
	}
	return nearestPartLeads(root) ? "gone" : "unreadable";
}

/**
 * Whether the nearest part above `path` that lstat finds is a folder,
 * or a link that leads somewhere.
 *
 * @param {string} path
 * @returns {boolean}
 */
function nearestPartLeads(path) {
	for (let part = dirname(path); ; part = dirname(part)) {
		try {
			if (!lstatSync(part).isSymbolicLink()) return true;
		} catch (error) {
			if (codeOf(error) !== "ENOENT") return false;
			if (dirname(part) === part) return true;
			continue;
		}
		try {
			statSync(part);
			return true;
		} catch {
			// A link whose target won't stat leads nowhere.
			return false;
		}
	}
}

/**
 * @param {string} path
 * @returns {string}
 */
function withoutTrailingSlash(path) {
	let trimmed = path;
	while (trimmed.length > 1 && trimmed.endsWith(sep))
		trimmed = trimmed.slice(0, -1);
	return trimmed;
}

/**
 * @param {unknown} error
 * @returns {string | undefined}
 */
function codeOf(error) {
	return typeof error === "object" && error !== null && "code" in error
		? String(error.code)
		: undefined;
}

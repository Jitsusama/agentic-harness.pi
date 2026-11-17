/**
 * The disk as the fence reads it: what a path is, what a folder holds
 * and where a link ends. The fence's arguments are worked out from it,
 * and a test hands in a disk of its own.
 */

import { lstatSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
	holdsSessionBus,
	lockFolder,
	QUEST_LOCKS,
} from "../quest/lock-folder.ts";

/** What the fence needs to know of the disk: what a path is, and what a folder holds. */
export interface Disk {
	kind(path: string): "folder" | "file" | "link" | undefined;
	entries(folder: string): readonly string[];
	/** Where a path ends once its links are followed, if it ends anywhere. */
	real?(path: string): string | undefined;
	/**
	 * The quest lock folder in a login's runtime folder, made if it isn't
	 * there, and whether it may be bound: undefined where the runtime
	 * folder holds no session bus, and so no writer outside locks there.
	 */
	questLocks?(
		runtimeDir: string,
	): { readonly folder: string; readonly ours: boolean } | undefined;
}

/** The disk as it is. */
export const DISK: Disk = {
	kind(path) {
		try {
			const stat = lstatSync(path);
			if (stat.isSymbolicLink()) return "link";
			return stat.isDirectory() ? "folder" : "file";
		} catch {
			// Not there, so nothing to bind.
			return undefined;
		}
	},
	entries(folder) {
		try {
			return readdirSync(folder);
		} catch {
			// No folder to read, so nothing in it to bind.
			return [];
		}
	},
	real(path) {
		try {
			return realpathSync(path);
		} catch {
			// A link to nothing: there is no file to bind over.
			return undefined;
		}
	},
	questLocks(runtimeDir) {
		if (!holdsSessionBus(runtimeDir)) return undefined;
		const folder = join(runtimeDir, QUEST_LOCKS);
		try {
			mkdirSync(folder, { recursive: true, mode: 0o700 });
		} catch {
			// Something else stands there: judged, and refused, below.
		}
		return { folder, ours: lockFolder(folder) === "ours" };
	},
};

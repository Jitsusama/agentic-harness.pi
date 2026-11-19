/**
 * The folders in the real `/tmp` that a pi or node outside the fence
 * keeps compiled code in and runs again at its next start, and how the
 * fence keeps a fenced command from planting code there.
 *
 * node keeps its compile cache in `/tmp/node-compile-cache` when nothing
 * names one (04TNWT, 19 November). pi names a folder of its state
 * instead (`compile-cache-place.ts`), but a node or pi started without
 * that still reads this one. jiti keeps the TypeScript of every
 * extension pi loads, compiled, in the temporary folder's `jiti`, and
 * takes a cached file as long as its last line still names its source,
 * so code written ahead of that line runs. jiti takes no folder from its
 * environment, and turning its cache off made pi start in 40 s rather
 * than 3 s at the machine's load on 19 November.
 *
 * Inside, each folder that is there is the real one with every write
 * going to a tmpfs of the fence's own, which goes when the command
 * does: a fenced pi still starts from the warm cache, and nothing it
 * writes reaches one outside. One that isn't there is a tmpfs of the
 * fence's own, which bubblewrap makes a folder for. Either way it is a
 * mount, which a command inside can neither rename nor remove.
 */

import { lstatSync, renameSync } from "node:fs";
import type { Disk } from "./fence-disk.ts";

/** The folders, where pi and node keep them in the real `/tmp`. */
export const TEMP_CODE_CACHES = [
	"/tmp/node-compile-cache",
	"/tmp/jiti",
] as const;

/** bubblewrap's arguments for `folders`, as the disk holds them. */
export function tempCacheArgs(
	folders: readonly string[],
	disk: Disk,
): string[] {
	return folders.flatMap((folder) => {
		const kind = disk.kind(folder);
		if (kind === "folder") {
			return ["--overlay-src", folder, "--tmp-overlay", folder];
		}
		// bubblewrap won't mount on a link and can't over a file, so one
		// another account left there keeps its place; one of ours is set
		// aside before the fence starts (`setAsidePlanted`).
		return kind === undefined ? ["--tmpfs", folder] : [];
	});
}

/**
 * Move a link or file of this account's at one of `folders` aside,
 * named for when it was found, so the fence can mount there and node
 * and jiti outside make the folder anew. Before this fence, a fenced
 * command could put one there pointing at a folder of its choosing.
 * Another account's is left, since `/tmp` lets only its owner move it.
 */
export function setAsidePlanted(
	folders: readonly string[] = TEMP_CODE_CACHES,
	now: () => number = Date.now,
): void {
	for (const folder of folders) {
		const stat = lstatSync(folder, { throwIfNoEntry: false });
		if (!stat || stat.isDirectory()) continue;
		if (process.getuid && stat.uid !== process.getuid()) continue;
		try {
			renameSync(folder, `${folder}.set-aside-${now()}`);
		} catch {
			// Gone or moved meanwhile: the fence mounts whatever is there.
		}
	}
}

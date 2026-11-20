/**
 * The folders in the temporary folder that a pi or node outside the
 * fence keeps compiled code in and runs again at its next start, and how
 * the fence keeps a fenced command from planting code there.
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

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstatSync, realpathSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DISK, type Disk } from "./fence-disk.ts";

/** The folders, where pi and node keep them in the real `/tmp`. */
export const TEMP_CODE_CACHES = [
	"/tmp/node-compile-cache",
	"/tmp/jiti",
] as const;

/**
 * The account's own temporary folder on a Mac, as the system names it
 * whatever TMPDIR says, or nothing where it won't say.
 */
export function accountsTemp(): string | undefined {
	try {
		return (
			execFileSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], {
				encoding: "utf8",
			}).trim() || undefined
		);
	} catch {
		return undefined;
	}
}

/**
 * The folders on this machine: `/tmp`'s, and on a Mac those of the
 * account's own temporary folder and of `os.tmpdir()` too. The person's
 * own pis keep theirs in the account's folder, which the system names,
 * while whoever starts the fence may hand it another TMPDIR or none, so
 * both are held, never one in place of the other. On Linux a pi outside
 * starts with the system's, a quest's being kept from them
 * (`supervisor-request.ts`).
 */
export function tempCodeCaches(
	platform: NodeJS.Platform = process.platform,
	temps: () => readonly (string | undefined)[] = () => [
		accountsTemp(),
		tmpdir(),
	],
): readonly string[] {
	if (platform !== "darwin") return TEMP_CODE_CACHES;
	const held: string[] = [...TEMP_CODE_CACHES];
	for (const temp of temps()) {
		if (!temp) continue;
		let own: string;
		try {
			own = realpathSync(temp);
		} catch {
			continue;
		}
		if (own === "/tmp" || own === "/private/tmp") continue;
		for (const cache of ["node-compile-cache", "jiti"]) {
			const folder = join(own, cache);
			if (!held.includes(folder)) held.push(folder);
		}
	}
	return held;
}

/**
 * Why the fence won't start, if a link or file is left at one of
 * `folders` once `setAsidePlanted` has had its turn: bubblewrap can mount
 * on neither, and a link there leads node and jiti outside to wherever it
 * points. Callers ask before laying the fence, so it is refused as any
 * other refusal is, logged and with the fence's own exit status.
 */
export function plantedCache(
	folders: readonly string[] = tempCodeCaches(),
	disk: Disk = DISK,
): string | undefined {
	for (const folder of folders) {
		const kind = disk.kind(folder);
		if (kind === "folder" || kind === undefined) continue;
		return (
			`the fence won't start: ${folder} is a ${kind}, not a folder, and couldn't be ` +
			"moved aside. Something may have put it there to plant code: look at what " +
			"it is and who owns it before moving it away, which for another account's " +
			"takes root."
		);
	}
	return undefined;
}

/**
 * bubblewrap's arguments for `folders`, as the disk holds them. One that
 * `plantedCache` would refuse throws, which a caller that asked first
 * never meets.
 */
export function tempCacheArgs(
	folders: readonly string[],
	disk: Disk,
): string[] {
	const planted = plantedCache(folders, disk);
	if (planted) throw new Error(planted);
	return folders.flatMap((folder) =>
		disk.kind(folder) === "folder"
			? ["--overlay-src", folder, "--tmp-overlay", folder]
			: ["--tmpfs", folder],
	);
}

/**
 * Move a link or file of this account's at one of `folders` aside,
 * under a name nobody can guess ahead, so the fence can mount there and
 * node and jiti outside make the folder anew. Before this fence, a
 * fenced command could put one there pointing at a folder of its
 * choosing. Another account's is left, since `/tmp` lets only its owner
 * move it, and `tempCacheArgs` then refuses the fence.
 */
export function setAsidePlanted(
	folders: readonly string[] = tempCodeCaches(),
	now: () => number = Date.now,
): void {
	for (const folder of folders) {
		const stat = lstatSync(folder, { throwIfNoEntry: false });
		if (!stat || stat.isDirectory()) continue;
		if (process.getuid && stat.uid !== process.getuid()) continue;
		try {
			renameSync(
				folder,
				`${folder}.set-aside-${now()}-${randomBytes(4).toString("hex")}`,
			);
		} catch {
			// Gone or moved meanwhile; one still there refuses the fence.
		}
	}
}

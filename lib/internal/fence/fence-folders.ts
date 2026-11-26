/**
 * Folders the fence keeps for this account alone, outside any sandbox:
 * making one where several pis may race to, and judging one found there,
 * so a link or a folder another account left is never taken for pi's
 * own. The session copies of dev's settings (`fence-dev.ts`) and of
 * gcloud's ssh files (`fence-gcloud-ssh.ts`) are both kept in them.
 */

import { lstatSync, mkdirSync } from "node:fs";

/**
 * Makes the folder `path` for this account alone, where no one has yet:
 * another pi making the same one at the same moment wins the race, and
 * the caller judges the folder it finds as any found there.
 */
export function makeFolder(path: string): void {
	try {
		mkdirSync(path, { mode: 0o700 });
	} catch (error) {
		// Another pi made it first, which the caller then judges.
		if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
			throw error;
	}
}

/** Whether `path` is a folder itself, owned by this process's account. */
export function isOwnFolder(path: string): boolean {
	try {
		const stat = lstatSync(path);
		const uid = process.getuid?.();
		return stat.isDirectory() && (uid === undefined || stat.uid === uid);
	} catch {
		// Not there.
		return false;
	}
}

/** Whether `path` is this account's own folder, which no other may reach, not a link to one. */
export function isPrivateFolder(path: string): boolean {
	try {
		return isOwnFolder(path) && (lstatSync(path).mode & 0o077) === 0;
	} catch {
		// Not there.
		return false;
	}
}

/**
 * The quest lock folder, bound back writable into the fence's empty
 * runtime folder, so a fenced writer and one outside take one lock.
 */

import type { Disk } from "./fence-disk.ts";

/**
 * bubblewrap's arguments for the quest lock folder in `runtimeDir`,
 * which the fence has just emptied: the folder bound back writable, and
 * nothing else there, where the runtime folder is a login's own. Bound
 * only where it is a folder of this user's alone; for anything else (a
 * link, another's, open to others) an empty file stands in its place,
 * which a fenced writer reads as no folder let through and so writes no
 * quest rather than lock where writers outside never look (ISXEG8, 17
 * November). Nothing where the runtime folder holds no bus, since
 * writers outside lock in each quest's `.writing` there too.
 */
export function questLockArgs(runtimeDir: string, disk: Disk): string[] {
	const locks = disk.questLocks?.(runtimeDir);
	if (!locks) return [];
	return locks.ours
		? ["--bind", locks.folder, locks.folder]
		: ["--ro-bind", "/dev/null", locks.folder];
}

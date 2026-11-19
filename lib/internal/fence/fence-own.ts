/**
 * Quests' folders of one kind in the fence, its scratch folders or its
 * shared ones: every one read-only, the session's quest's own writable.
 */

import type { Disk } from "./fence-disk.ts";

/** Where quests' folders of one kind live, and this session's quest's own. */
export interface OwnFolders {
	readonly root: string;
	readonly own?: string;
}

/**
 * bubblewrap's arguments for quests' scratch or shared folders: every
 * one read-only, this session's quest's own bound back writable. Other
 * quests keep clones there, whose settings pi's git, and their own
 * sessions', run outside the fence.
 */
export function ownArgs(folders: OwnFolders | undefined, disk: Disk): string[] {
	if (!folders || disk.kind(folders.root) !== "folder") return [];
	const own =
		folders.own && disk.kind(folders.own) === "folder"
			? ["--bind", folders.own, folders.own]
			: [];
	return ["--ro-bind", folders.root, folders.root, ...own];
}

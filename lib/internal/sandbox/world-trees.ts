/**
 * The World trees a strict session may write besides its folder: each
 * tree the work broker's records hold for it alone that stands in
 * World's trees folder as a worktree. Under strict only the working
 * folder was writable, so a lane that cut a World tree and worked in it
 * from its quest's folder could read and write none of it (HMYVFW,
 * through ISXEG8).
 *
 * Only the broker's records grant, since only the broker writes them,
 * outside every sandbox. A tree the session's quest adopted grants
 * nothing: adopting is the session's own act (the quest tool, or the
 * quest guard adopting where a write lands), and its README lies where
 * a strict command in the quest's folder may rewrite it, so a session
 * steered by a stranger's text could have granted itself another lane's
 * tree. A tree the records name for several sessions, as a snapshot
 * shared between readers, grants none of them: one writing it would
 * change what the others read.
 *
 * A tree counts only where it really lies strictly inside the folder
 * `~/world/trees` leads to, reached through no link beneath it, and holds
 * a `.git` file: never World's trees folder itself, its repository, or a
 * link inside the folder that leaves it or leads to another session's
 * tree. A tree elsewhere is left to the fence's own rules.
 */

import { lstatSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { treesHeldAloneBy } from "../work-records.ts";
import { lies, real, worktreeRepository } from "./tree-git.ts";

/** A World tree a strict session writes, and the repository git reads there. */
export interface WorldTree {
	readonly tree: string;
	/** The git folder of the repository it is a worktree of, when it is one. */
	readonly repository?: string;
}

/** Where World's trees stand, for the home folder `home`. */
function worldTreesFolder(home: string): string {
	return join(home, "world", "trees");
}

/**
 * The World trees among `named`, each as it really is and once, with
 * the repository each is a worktree of outside the home folder.
 */
export function worldTreesAmong(
	named: readonly string[],
	home: string,
): WorldTree[] {
	const folder = worldTreesFolder(home);
	const top = real(folder);
	// A trees folder leading to the root, or holding the home, would make
	// every checkout there a World tree.
	if (top === "/" || lies(real(home), top)) return [];
	const seen = new Set<string>();
	return named.flatMap((path): WorldTree[] => {
		const tree = worldTreeAt(resolve(path), folder, top);
		if (tree === undefined || seen.has(tree)) return [];
		seen.add(tree);
		const repository = worktreeRepository(tree, home);
		return [repository ? { tree, repository } : { tree }];
	});
}

/**
 * `path` as it really is, when it lies strictly inside the trees folder,
 * named as `folder` or as `top`, where it leads, with no link beneath it,
 * and is a folder holding a `.git` file.
 */
function worldTreeAt(
	path: string,
	folder: string,
	top: string,
): string | undefined {
	const from = lies(path, folder) ? folder : lies(path, top) ? top : undefined;
	if (from === undefined) return undefined;
	const below = relative(from, path);
	if (below === "") return undefined;
	const tree = join(top, below);
	if (real(path) !== tree) return undefined;
	try {
		if (!statSync(tree).isDirectory()) return undefined;
		return lstatSync(join(tree, ".git")).isFile() ? tree : undefined;
	} catch {
		// Gone, or no `.git` file: no tree to write.
		return undefined;
	}
}

/**
 * The World trees a strict session `session` writes: those the broker's
 * records `records` hold for it alone, as {@link worldTreesAmong} keeps
 * them.
 */
export function sessionWorldTrees(
	session: string | undefined,
	home: string,
	records?: string,
): WorldTree[] {
	return worldTreesAmong(heldAloneBy(session, records), home);
}

/** The trees the records hold for `session` alone; none where they can't be read. */
function heldAloneBy(session: string | undefined, records?: string): string[] {
	if (!session) return [];
	try {
		return treesHeldAloneBy(session, records);
	} catch {
		// Unread records grant nothing: a command writes fewer trees.
		return [];
	}
}

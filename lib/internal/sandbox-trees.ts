/**
 * Which tree a fenced session's command stands in, and the git folder a
 * call outside the fence is held to there: a worktree's own folder, a
 * tree the work tool's records hold for the session, or a checkout the
 * fence guards.
 */

import { join, resolve } from "node:path";
import { guardsGitFolder } from "./fence.ts";
import type { HeldGit } from "./offload-exemption.ts";
import { namedGitFolder, real, treeGit } from "./tree-git.ts";
import { treesHeldBy } from "./work-records.ts";

/** The folder a worktree's `.git` file names, or nothing when `cwd` has none. */
export function worktreeFolder(cwd: string): string | undefined {
	try {
		return namedGitFolder(cwd);
	} catch {
		// No .git file here: a plain folder, or a clone's own git folder.
		return undefined;
	}
}

/**
 * `folder` as it really is, when it is a tree the work tool's records
 * hold for `session`, named as it is rather than through a link, whose
 * `.git` file, its git folder's way back and its `commondir` all agree
 * on one repository outside the home folder, with the git folder they
 * name; nothing otherwise. What a `cd` before an exempt nix-offload call
 * must be, and the git folder the call is held to.
 */
export function heldTree(
	folder: string,
	home: string,
	session: string | undefined,
	records?: string,
): HeldGit | undefined {
	if (!session) return undefined;
	const named = resolve(folder);
	if (real(named) !== named) return undefined;
	const held = treesHeldBy(session, records).some(
		(tree) => real(tree) === named,
	);
	if (!held) return undefined;
	const git = treeGit(named, home);
	return git ? { folder: named, gitDir: git.gitDir } : undefined;
}

/**
 * `folder` as it really is, with the git folder a call outside the fence
 * is held to there: a tree the session holds, as {@link heldTree} has
 * it, or the top of a checkout whose own `.git` folder the fence keeps
 * read-only; nothing for any other folder, a checkout's subfolder
 * among them.
 */
export function folderGit(
	folder: string,
	home: string,
	session: string | undefined,
	records?: string,
): HeldGit | undefined {
	const held = heldTree(folder, home, session, records);
	if (held) return held;
	const top = real(resolve(folder));
	const git = join(top, ".git");
	return guardsGitFolder(git, real(home))
		? { folder: top, gitDir: git }
		: undefined;
}

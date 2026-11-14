/**
 * Which tree a fenced session's command stands in, and the git folder a
 * call outside the fence is held to there: a worktree's own folder, a
 * tree the work tool's records hold for the session, or a checkout the
 * fence guards.
 */

import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { guardsGitFolder } from "./fence.ts";
import type { BrokerTrees } from "./fence-broker-trees.ts";
import type { HeldGit } from "./offload-exemption.ts";
import { namedGitFolder, real, treeGit } from "./tree-git.ts";
import { cutTreeDir, treeRecordDir, treesHeldBy } from "./work-records.ts";

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

/**
 * The trees each session holds, as last read, by the records folder's
 * change time: every record is written beside and renamed in, so the
 * folder's time moves with each one, and a thousand records aren't read
 * again for every command.
 */
const HELD = new Map<
	string,
	{ readonly at: number; readonly held: string[] }
>();

/**
 * The work broker's trees as the fence keeps them for `session`: the
 * folder they're cut in, the records saying who holds each, and the
 * trees the records hold for this session, as they really are.
 */
export function brokerTrees(
	session: string | undefined,
	namedRoot: string = cutTreeDir(),
	namedRecords: string = treeRecordDir(),
): BrokerTrees {
	// As they really are, as the held trees are, so a tree is found in
	// its folder whatever links lead there.
	const root = real(namedRoot);
	const records = real(namedRecords);
	if (!session) return { root, records, held: [] };
	let at: number;
	try {
		at = statSync(records).mtimeMs;
	} catch {
		// No records yet: the session holds no tree.
		return { root, records, held: [] };
	}
	const key = `${records} ${session}`;
	const known = HELD.get(key);
	if (known && known.at === at) return { root, records, held: known.held };
	const held = treesHeldBy(session, records).map(real);
	HELD.set(key, { at, held });
	return { root, records, held };
}

/**
 * Which worktrees a fenced session writes: the one it stands in and every
 * other it holds. An agent cuts a tree with the work tool and works in it
 * from a command started in its session's folder, so on 15 November,
 * with only the working tree written, git in a held tree could write no
 * index or FETCH_HEAD inside, a World tree couldn't be written at all,
 * and pi's write tool refused them all. Each is now written alike: its
 * files and its own folder in its repository's `worktrees`, with what
 * points it elsewhere read-only (`fence.ts`), and its shared folder
 * watched (`fence-git-root.ts`).
 */

/** A worktree a session writes, and its own folder in its repository's git folder. */
export interface HeldWorktree {
	readonly tree: string;
	readonly gitFolder: string;
}

/** Where a fenced session stands and what it holds besides. */
export interface Worktrees {
	/** The working folder, when it is a worktree. */
	readonly cwd?: string;
	/** The working worktree's own folder in its repository's `worktrees`. */
	readonly ownGitFolder?: string;
	/** The other worktrees the session holds. */
	readonly heldWorktrees?: readonly HeldWorktree[];
}

/** The worktree the session works in, then the others it holds, each once. */
export function writtenWorktrees(place: Worktrees): HeldWorktree[] {
	const working =
		place.cwd && place.ownGitFolder
			? [{ tree: place.cwd, gitFolder: place.ownGitFolder }]
			: [];
	const seen = new Set<string>();
	return [...working, ...(place.heldWorktrees ?? [])].filter(({ tree }) => {
		if (seen.has(tree)) return false;
		seen.add(tree);
		return true;
	});
}

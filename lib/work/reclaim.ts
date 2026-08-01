/**
 * Taking back a tree nothing owns any more.
 *
 * This is the one cleanup verb here that acts rather than reporting,
 * and the asymmetry with {@link tidyPlan} is deliberate. Deleting a
 * branch destroys the only name a commit had, so tidy refuses to do
 * it. Removing a worktree destroys a directory and git's bookkeeping
 * for it, and leaves the branch exactly where it was: the commits stay
 * reachable, and re-cutting the tree at the same branch puts a person
 * back where they were. A report whose only follow-through is the
 * `git worktree` call the guide says never to make is not a path, so
 * this supplies the path.
 *
 * What may be taken back is {@link orphanedTrees}'s decision, and this
 * removes nothing it did not offer. The dirty tree and the tree whose
 * work trunk cannot vouch for stay where they are.
 */

import { type Exec, run } from "../exec/index.js";
import { displayPath } from "../ui/path.js";
import type { Reclaimable } from "./tidy.js";

/** What became of one tree. */
export type ReclaimedTree =
	| { kind: "reclaimed"; path: string; branch?: string }
	/**
	 * Git would not let go of it, and the tree is still there.
	 *
	 * Reported per tree rather than thrown, because the whole point of
	 * this verb is a backlog: one tree git objects to must not strand
	 * the fourteen behind it.
	 */
	| { kind: "refused"; path: string; why: string };

/** What a sweep did, tree by tree, in the order it went. */
export interface ReclaimOutcome {
	trees: ReclaimedTree[];
}

/** Where a reclaim runs and what it runs with. */
export interface ReclaimDeps {
	exec: Exec;
	/** The checkout git's worktree bookkeeping lives in. */
	mainPath: string;
}

/**
 * Take back each tree offered, and say what happened to every one.
 *
 * The branch is never touched. `git worktree remove` takes the
 * directory and the administrative files; whatever was checked out
 * there is still a branch afterwards, which is what makes this
 * recoverable and therefore allowed to act.
 */
export async function reclaimTrees(
	deps: ReclaimDeps,
	offered: readonly Reclaimable[],
): Promise<ReclaimOutcome> {
	const trees: ReclaimedTree[] = [];

	for (const tree of offered) {
		try {
			await run(
				deps.exec,
				"git",
				["-C", deps.mainPath, "worktree", "remove", tree.path],
				`Taking back ${displayPath(tree.path)}`,
			);
			trees.push({
				kind: "reclaimed",
				path: tree.path,
				...(tree.branch ? { branch: tree.branch } : {}),
			});
		} catch (error) {
			// Git's own words. It refuses a tree with anything untracked in
			// it even when status called the tree clean, since an ignored
			// build directory is untracked too, and hearing that from git
			// beats being told the tree "could not be removed".
			trees.push({
				kind: "refused",
				path: tree.path,
				why: error instanceof Error ? error.message : String(error),
			});
		}
	}

	return { trees };
}

/**
 * Which stack members' heads a stack round may record as read.
 *
 * A stack round reads one tree, cut at the tip, and records every
 * member's listed head as what it read of that member. That holds only
 * while the tip's history holds the member's head: a member pushed
 * since the tip was last rebased onto it, or a sibling branch in a
 * stack that fans out, carries a head the tree never had. Recording it
 * would let reviewed-first pass a head no reviewer saw, so a member is
 * witnessed only when git says its head is the tip's or an ancestor of
 * it, and is otherwise named as unread.
 */

import type { Exec } from "../../exec/index.ts";

/** What a stack round may record of each member's head. */
export interface StackWitnesses {
	/** Each member, by its ref, whose head the tip's history holds. */
	readonly held: ReadonlyMap<string, string>;
	/** The members with a head the tip's history doesn't hold. */
	readonly unheld: readonly string[];
}

/**
 * Sort each member's listed head into held or unheld by the tip's
 * history in the repository at `root`. A member listing no head is
 * neither, since there is nothing to record; a head git can't place
 * (missing, or not an ancestor) is unheld, and so is every head when
 * the tip lists none, since then no history says what the tree held.
 */
export async function stackWitnesses(
	exec: Exec,
	root: string,
	tip: string | undefined,
	heads: ReadonlyMap<string, string | undefined>,
): Promise<StackWitnesses> {
	const held = new Map<string, string>();
	const unheld: string[] = [];
	for (const [ref, head] of heads) {
		if (head === undefined) continue;
		if (
			tip !== undefined &&
			(head === tip || (await isAncestor(exec, root, head, tip)))
		) {
			held.set(ref, head);
		} else {
			unheld.push(ref);
		}
	}
	return { held, unheld };
}

/** Whether git places `commit` in `tip`'s history. */
async function isAncestor(
	exec: Exec,
	root: string,
	commit: string,
	tip: string,
): Promise<boolean> {
	const result = await exec("git", [
		"-C",
		root,
		"merge-base",
		"--is-ancestor",
		"--end-of-options",
		commit,
		tip,
	]);
	// git answers no (not an ancestor, or a commit it lacks) by its exit
	// code, and either way the head goes unrecorded.
	return result.code === 0;
}

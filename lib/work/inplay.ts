/**
 * Which held tree a call should act on when nobody said.
 *
 * Fifteen of the tool's actions take a tree, and until this existed every one of them
 * had to be told which, every time, even for a session holding exactly one. The review
 * side solved the same problem for changes and the browser solved it before that for
 * sessions; this is the third turn of one idea, so it is written the same way.
 *
 * It is deliberately less willing to guess than the change version, and the difference
 * is worth stating. There, several attached changes resolve to the most recent, because
 * attaching one is how somebody says what they are working on, so recency is a
 * statement of intent. Nothing here makes that statement: trees accumulate as you cut
 * them, and the tool's actions include committing, pushing and replaying, where acting
 * on the wrong one rewrites work in a directory nobody was looking at. So one tree is
 * used and several is a question.
 */

/**
 * The tree a call will act on.
 *
 * No note field, deliberately, and this is where it differs from the change version
 * again. There, a note says which change was chosen, because a change is a thing you
 * read and the answer need not mention it. Here every action already announces itself
 * against the tree it acted on, as in `Recorded 3 paths in worktree-fix-410`, so a note
 * would repeat what the next line says. A field nothing reads is worse than a missing
 * one, because it does not present as missing.
 */
export interface TreeInPlay {
	readonly key: string;
}

/** No single answer, so the caller has to choose. */
export interface TreeAmbiguous {
	readonly candidates: readonly string[];
}

/**
 * Resolve the tree in play from what the caller said and what is held.
 *
 * An explicit name is never second-guessed, even when it matches nothing: somebody who
 * names a tree means that tree, and a typo is better reported than quietly redirected
 * to whatever else happens to be open.
 */
export function treeInPlay(
	asked: string | undefined,
	held: readonly string[],
): TreeInPlay | TreeAmbiguous {
	if (asked !== undefined) return { key: asked };

	const [only, ...rest] = held;
	if (only === undefined) return { candidates: held };
	if (rest.length > 0) return { candidates: held };

	return { key: only };
}

/** Say what to choose between, when the choice cannot be made here. */
export function chooseTree(candidates: readonly string[]): string {
	if (candidates.length === 0) {
		return (
			"No tree is held. Ask for one with work tree, naming the repo, the " +
			"branch and what it is for."
		);
	}
	return (
		`Say which tree, by its key or its path. ${candidates.length} are held: ` +
		`${candidates.join(", ")}.`
	);
}

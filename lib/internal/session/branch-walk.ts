/**
 * Reading a session's branch by walking back from its leaf through each
 * entry's parent, rather than asking pi for the whole branch.
 *
 * Pi's `getBranch` walks every entry from the leaf to the root and
 * copies them into a fresh array, so a handler that asks for it after
 * every turn or request pays for the whole session each time: on 10
 * November the compaction's kept head and the selection's tagger put
 * about 1.2 s of main-thread runs of 50 ms or more into ten minutes of
 * a session with a 24 MB log. Most of what they
 * work out is a fold over the branch from its root, and every entry pi
 * appends becomes the new leaf, so walking back from the leaf to the one
 * last folded and folding only what lies between gives the same answer.
 * A leaf on another branch never meets the one last folded, and is
 * folded from the root.
 */

/** A session entry, as far as a walk back from the leaf reads one. */
export interface LinkedEntry {
	readonly id: string;
	readonly parentId: string | null;
}

/** The parts of pi's session manager a walk reads. */
export interface BranchReader<E extends LinkedEntry> {
	getLeafId(): string | null | undefined;
	getEntry(id: string): E | undefined;
}

/**
 * A fold over a branch from its root: where it starts, and how it takes
 * each entry. `step` may change the state it is given and return it, so
 * the state a fold answers with is its live one, to be read at once.
 */
export interface BranchFold<S, E extends LinkedEntry> {
	start(): S;
	step(state: S, entry: E): S;
}

/**
 * `fold` as a reading of a session at its leaf now, kept per session by
 * its manager, which pi keeps for the session's life.
 */
export function foldedBranch<S, E extends LinkedEntry>(
	fold: BranchFold<S, E>,
): (session: BranchReader<E>) => S {
	const told = new WeakMap<object, { leaf: string; state: S }>();
	return (session) => {
		const leaf = session.getLeafId();
		if (!leaf) return fold.start();
		const before = told.get(session);
		if (before?.leaf === leaf) return before.state;
		const gained: E[] = [];
		let met = false;
		let id: string | null = leaf;
		while (id !== null) {
			if (id === before?.leaf) {
				met = true;
				break;
			}
			const entry = session.getEntry(id);
			if (entry === undefined) break;
			gained.push(entry);
			id = entry.parentId;
		}
		let state = met && before ? before.state : fold.start();
		for (const entry of gained.reverse()) state = fold.step(state, entry);
		told.set(session, { leaf, state });
		return state;
	};
}

/** The `count` entries before `entry` on its branch, oldest first. */
export function entriesBefore<E extends LinkedEntry>(
	session: BranchReader<E>,
	entry: E,
	count: number,
): E[] {
	const before: E[] = [];
	let id = entry.parentId;
	while (id !== null && before.length < count) {
		const parent = session.getEntry(id);
		if (parent === undefined) break;
		before.push(parent);
		id = parent.parentId;
	}
	return before.reverse();
}

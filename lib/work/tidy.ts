/**
 * What is safe to remove once work has landed.
 *
 * Cleaning up after a merge is done by hand today, and the cost of not
 * doing it is quiet: stale locals and tracking refs pile up until a
 * branch listing stops being readable. The cost of doing it carelessly
 * is not quiet at all, so nothing here removes anything. It decides
 * what could go and, for everything it will not touch, says why.
 *
 * It has to be a decision rather than a command because landing is not
 * an instant. A change handed to a merge queue is merged later, from
 * somewhere else, so the moment a caller asks to merge is exactly the
 * moment nothing is cleanable yet.
 */

/** One worktree, as git describes it. */
export interface WorktreeOnDisk {
	path: string;
	/** The branch checked out there, when one is. */
	branch?: string;
	/** Whether it holds changes that are not committed anywhere. */
	dirty?: boolean;
	/** Whether trunk already contains that branch's commits. */
	mergedIntoTrunk?: boolean;
}

/** What is known when asking which trees were left behind. */
export interface OrphanAsk {
	/** The checkout the worktrees hang off, which is never an orphan. */
	mainPath: string;
	/** Every worktree git knows about, the main checkout included. */
	worktrees: WorktreeOnDisk[];
	/**
	 * Paths the broker still remembers holding.
	 *
	 * Must be comparable with the worktree paths above, which means the
	 * caller resolves both through the same lens before asking. The two
	 * arrive from different places, git and the broker's own record, and
	 * git reports a path with every symlink resolved: on macOS a tree
	 * under the system temp comes back as `/private/var/...` where the
	 * broker wrote `/var/...`. Compared raw, a tree somebody is actively
	 * holding reads as abandoned, which is the one wrong answer here
	 * that costs work.
	 */
	remembered: readonly string[];
	/**
	 * Those whose record says nothing about who cut them.
	 *
	 * Every record written before the broker stamped an owner is one of
	 * these, and there is no sound way to attribute one after the fact.
	 * The obvious rules all fail. The machine has not rebooted since
	 * they were written, so nothing can be ruled out that way, and any
	 * age threshold is a guess that takes a live session's tree the
	 * first time somebody leaves one open over a weekend.
	 *
	 * So they are neither held nor reclaimable: they are reported as a
	 * decision for a person, which is the honest answer and is also
	 * self-clearing, since a tree taken this way is gone and every tree
	 * cut from now on carries an owner.
	 */
	unattributed?: readonly string[];
}

/** A tree nothing claims any more, and what was in it. */
export interface Reclaimable {
	path: string;
	branch?: string;
}

/** A tree being left alone, and the reason. */
export interface Retained {
	path: string;
	why: string;
	/** Set when this is a judgement call rather than a refusal. */
	decide?: boolean;
}

/** What reclaiming would do, and what it would decline to do. */
export interface OrphanPlan {
	reclaimable: Reclaimable[];
	retained: Retained[];
}

/**
 * Which trees have been left behind, without reclaiming any of them.
 *
 * A worktree outlives the process that cut it, which is the point of
 * one, and it also outlives a process that was killed before it could
 * put the tree back. Nothing then owns it: the broker's memory has no
 * record, so every verb answers "no held tree", while git still tracks
 * it and the disk still carries it. Fifteen accumulated in one repo
 * over four months, all of them from an extension that no longer
 * exists, which is what this looks like when nobody is watching.
 *
 * The order of the questions is the safety, as with {@link tidyPlan}.
 * The checkout itself and anything still claimed are excluded
 * before merge state is considered, so no confusion further down can
 * propose removing either.
 */
export function orphanedTrees(ask: OrphanAsk): OrphanPlan {
	const held = new Set(ask.remembered);
	const unattributed = new Set(ask.unattributed ?? []);
	const reclaimable: Reclaimable[] = [];
	const retained: Retained[] = [];

	for (const tree of ask.worktrees) {
		const keep = (why: string, decide?: boolean): void => {
			retained.push({ path: tree.path, why, ...(decide ? { decide } : {}) });
		};

		if (tree.path === ask.mainPath) {
			keep("it is the checkout the others hang off");
			continue;
		}
		if (held.has(tree.path)) {
			// Not an orphan at all, and saying so matters: giving it back
			// goes through whatever cut it, which knows things about taking
			// a tree down that this does not. Deliberately vague about who
			// holds it, because the broker is not the only one that can: a
			// quest holds trees against a piece of work and answers the
			// same question. Naming the broker would be wrong for those.
			keep(
				"something still holds it, so give it back rather than reclaiming it",
			);
			continue;
		}
		if (unattributed.has(tree.path)) {
			// After the held check, and the order is the safety. A claim is
			// somebody saying they want this now: a quest holds trees
			// against a piece of work and answers over the bus, and that is
			// a positive statement from something running. An unattributed
			// record is the absence of a statement. Asking this first
			// downgraded the one to the other, which put a tree somebody
			// had just claimed into the list a person is invited to clear.
			keep(
				"it was recorded before the broker wrote down who cut it, so nothing can say whether a running session still wants it",
				true,
			);
			continue;
		}
		if (tree.dirty) {
			// A refusal, not a decision. An uncommitted change exists in
			// exactly one place and removing the tree ends it.
			keep("it has uncommitted changes, which exist nowhere else");
			continue;
		}
		if (tree.mergedIntoTrunk) {
			reclaimable.push({
				path: tree.path,
				...(tree.branch ? { branch: tree.branch } : {}),
			});
			continue;
		}
		// The same ambiguity a branch has, for the same reason, and named
		// the same way rather than guessed at.
		keep(
			`nothing holds it, but ${tree.branch ?? "its branch"} is not contained in trunk, so it is either a squash merge or the only copy of that work`,
			true,
		);
	}

	return { reclaimable, retained };
}

/** One local branch, as git describes it. */
export interface LocalBranch {
	name: string;
	/** Whether trunk already contains this branch's commits. */
	mergedIntoTrunk: boolean;
	/** The upstream it tracks, when it tracks one. */
	tracking?: string;
	/** Whether that upstream has gone from the remote. */
	remoteGone?: boolean;
}

/** What the working layer knows when it is asked to tidy up. */
export interface TidyAsk {
	trunk: string;
	/** The branch currently checked out in the tree. */
	current: string;
	branches: LocalBranch[];
	/** Branches the stack is tracking, which must be forgotten too. */
	tracked?: string[];
}

/** A branch that can go, and what else goes with it. */
export interface Removable {
	branch: string;
	/** Whether the stack still lists it, so it needs untracking too. */
	alsoUntrack: boolean;
}

/** A branch being left alone, and the reason. */
export interface Kept {
	branch: string;
	why: string;
	/**
	 * Whether this is a judgement call rather than a refusal.
	 *
	 * Set when the work looks landed but git cannot prove it, which is
	 * what a squash merge produces and the one case where a person has
	 * to decide. Everything else here is simply not ready to go.
	 */
	decide?: boolean;
}

/** What tidying up would do, and what it would decline to do. */
export interface TidyPlan {
	removable: Removable[];
	keeping: Kept[];
	/** Whether any tracking ref points at a branch the remote dropped. */
	prunable: boolean;
}

/**
 * Work out what has been spent, without spending anything.
 *
 * The order of the questions is the safety. Trunk and the checked-out
 * branch are excluded before merge state is considered at all, so no
 * amount of confusion further down can propose deleting either.
 */
export function tidyPlan(ask: TidyAsk): TidyPlan {
	const tracked = new Set(ask.tracked ?? []);
	const removable: Removable[] = [];
	const keeping: Kept[] = [];

	for (const branch of ask.branches) {
		const kept = (why: string, decide?: boolean): void => {
			keeping.push({ branch: branch.name, why, ...(decide ? { decide } : {}) });
		};

		if (branch.name === ask.trunk) {
			kept("it is the trunk");
			continue;
		}
		if (branch.name === ask.current) {
			// Git refuses this anyway, and hearing why from here beats
			// hearing it from a command that has already deleted three
			// other branches and then stopped.
			kept("it is checked out here, so move off it first");
			continue;
		}
		if (branch.mergedIntoTrunk) {
			removable.push({
				branch: branch.name,
				alsoUntrack: tracked.has(branch.name),
			});
			continue;
		}
		if (branch.remoteGone) {
			// The case worth slowing down for. A squash merge lands the
			// work as a new commit, so the branch is not an ancestor of
			// trunk and git will not call it merged, while the remote
			// branch is gone because the merge deleted it. It looks
			// exactly like a branch somebody deleted out from under
			// unmerged work, and only a person can tell the two apart.
			kept(
				`its upstream ${branch.tracking ?? "branch"} is gone but ${ask.trunk} does not contain it, which is what a squash merge looks like and also what losing work looks like`,
				true,
			);
			continue;
		}
		kept(`${ask.trunk} does not contain it yet`);
	}

	return {
		removable,
		keeping,
		prunable: ask.branches.some((branch) => branch.remoteGone === true),
	};
}

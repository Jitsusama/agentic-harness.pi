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

/**
 * A stack of branches, each sitting on the one below it.
 *
 * Git does not track this. A branch knows its commits and nothing about which
 * other branch it was built on top of, so a stack is either recorded somewhere
 * or guessed at, and guessing is what makes stacked tooling feel haunted: infer
 * parentage from merge-base and the answer changes under you the moment two
 * branches share history for an unrelated reason.
 *
 * So parentage is recorded, and everything here is a function of that record.
 * This file is the part that thinks. It never runs git: it takes what the
 * record says and works out the order to replay in, what a reorder implies, and
 * which moves would produce something that is not a stack at all. The git side
 * is a thin adapter over these answers, which is what makes the hard part
 * testable without a repository.
 *
 * The one rule worth stating up front: a replay step carries the base the
 * branch was last aligned at, not just the branch and its new parent. Replaying
 * without it hands the branch every commit its parent already has, which is the
 * duplicated-commit mess that makes people abandon stacks and go back to one
 * enormous branch.
 */

/** A branch and what it sits on. */
export interface StackedBranch {
	name: string;
	/** What it sits on. Absent means it sits on trunk and is a root. */
	parent?: string;
	/**
	 * The parent's commit when this branch was last aligned with it.
	 *
	 * This is the boundary of what belongs to this branch. Without it a
	 * replay cannot tell which commits are its own, and hands the branch
	 * copies of everything its parent already carries.
	 */
	base?: string;
}

/** One replay a restack needs, in the order it has to happen. */
export interface ReplayStep {
	branch: string;
	/** What it is being replayed onto: a parent branch, or trunk. */
	onto: string;
	/** The base to replay from, when one is recorded. */
	from?: string;
}

/** One parentage change a reorder implies. */
export interface ReparentStep {
	branch: string;
	/** Its new parent, or trunk when it becomes a root. */
	parent?: string;
}

/** Why a set of branches is not a stack. */
export interface StackFault {
	kind: "cycle" | "unknown-parent" | "duplicate";
	/** The branches involved, so the message can name them. */
	branches: readonly string[];
	reason: string;
}

/** The reason a set of branches is not a stack. */
export interface Faulted {
	kind: "faulted";
	fault: StackFault;
}

/** Either an ordering or the reason there is not one. */
export type StackOrder =
	| { kind: "ordered"; branches: readonly StackedBranch[] }
	| Faulted;

/** Either a plan of replays or the reason there is not one. */
export type RestackPlan =
	| { kind: "planned"; steps: readonly ReplayStep[] }
	| Faulted;

/** Either a plan of parentage changes or the reason there is not one. */
export type ReorderPlan =
	| { kind: "planned"; steps: readonly ReparentStep[] }
	| Faulted;

/**
 * Put a stack in the order work has to happen: roots first, each branch after
 * whatever it sits on.
 *
 * A restack that runs out of order is worse than one that does not run: replay
 * a child onto its parent before the parent has moved and the child is now
 * aligned to a base that is about to stop existing.
 *
 * Siblings keep the order they were given. Nothing here can rank two branches
 * that sit on the same parent, and inventing a rank would make a restack's
 * output depend on a detail nobody chose.
 */
export function orderStack(branches: readonly StackedBranch[]): StackOrder {
	const byName = new Map<string, StackedBranch>();
	for (const branch of branches) {
		if (byName.has(branch.name)) {
			return {
				kind: "faulted",
				fault: {
					kind: "duplicate",
					branches: [branch.name],
					reason: `${branch.name} appears twice, so there is no single answer to what it sits on.`,
				},
			};
		}
		byName.set(branch.name, branch);
	}

	for (const branch of branches) {
		if (branch.parent !== undefined && !byName.has(branch.parent)) {
			return {
				kind: "faulted",
				fault: {
					kind: "unknown-parent",
					branches: [branch.name, branch.parent],
					reason: `${branch.name} sits on ${branch.parent}, which is not in this stack. Track it, or point ${branch.name} at something that is here.`,
				},
			};
		}
	}

	const ordered: StackedBranch[] = [];
	const placed = new Set<string>();
	// Walking to the root from each branch and placing ancestors first is
	// what makes a cycle visible: a chain that revisits a name it is
	// already walking has no root to reach.
	for (const branch of branches) {
		const chain: StackedBranch[] = [];
		const walking = new Set<string>();
		let at: StackedBranch | undefined = branch;
		while (at !== undefined && !placed.has(at.name)) {
			if (walking.has(at.name)) {
				return {
					kind: "faulted",
					fault: {
						kind: "cycle",
						branches: [...walking],
						reason: `${[...walking].join(" sits on ")} sits on ${at.name}, which closes a loop. A stack has to end somewhere.`,
					},
				};
			}
			walking.add(at.name);
			chain.unshift(at);
			at = at.parent === undefined ? undefined : byName.get(at.parent);
		}
		for (const one of chain) {
			if (placed.has(one.name)) continue;
			placed.add(one.name);
			ordered.push(one);
		}
	}

	return { kind: "ordered", branches: ordered };
}

/** Every branch sitting on this one, however far down. */
export function descendantsOf(
	branches: readonly StackedBranch[],
	name: string,
): readonly string[] {
	const found: string[] = [];
	const frontier = [name];
	while (frontier.length > 0) {
		const at = frontier.shift();
		for (const branch of branches) {
			if (branch.parent !== at || found.includes(branch.name)) continue;
			found.push(branch.name);
			frontier.push(branch.name);
		}
	}
	return found;
}

/**
 * The replays a restack needs, in order.
 *
 * `trunk` is what a root sits on. Every step carries the base its branch was
 * last aligned at, because that boundary is the only thing separating the
 * branch's own commits from its parent's.
 *
 * A branch whose base is unrecorded still gets a step. The adapter falls back
 * to asking git for a merge-base, which is a guess, but a guess made at the
 * moment of replaying and reported as one beats refusing to replay a branch
 * somebody tracked by hand.
 */
export function planRestack(
	branches: readonly StackedBranch[],
	trunk: string,
): RestackPlan {
	const order = orderStack(branches);
	if (order.kind === "faulted") return order;
	const steps = order.branches.map((branch) => ({
		branch: branch.name,
		onto: branch.parent ?? trunk,
		...(branch.base === undefined ? {} : { from: branch.base }),
	}));
	return { kind: "planned", steps };
}

/**
 * What a reorder implies, as parentage changes.
 *
 * The caller says the order it wants, root first, and gets back the reparenting
 * that produces it. Expressing a reorder as reparenting rather than as its own
 * operation is deliberate: there is only one way for a branch to move in a
 * stack, and a second vocabulary for it would be a second set of rules about
 * what is legal.
 *
 * The desired order has to name the same branches as the chain it is
 * reordering. Naming a subset would quietly orphan whatever was left out.
 */
export function planReorder(
	branches: readonly StackedBranch[],
	desired: readonly string[],
): ReorderPlan {
	const order = orderStack(branches);
	if (order.kind === "faulted") return order;

	const known = new Set(branches.map((branch) => branch.name));
	const missing = desired.filter((name) => !known.has(name));
	if (missing.length > 0) {
		return {
			kind: "faulted",
			fault: {
				kind: "unknown-parent",
				branches: missing,
				reason: `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not in this stack, so ${missing.length === 1 ? "it" : "they"} cannot be placed in it.`,
			},
		};
	}
	const duplicated = desired.filter((name, at) => desired.indexOf(name) !== at);
	if (duplicated.length > 0) {
		return {
			kind: "faulted",
			fault: {
				kind: "duplicate",
				branches: duplicated,
				reason: `${duplicated.join(", ")} appears more than once in the order asked for, and a branch can only sit in one place.`,
			},
		};
	}

	// Reordering a chain means reordering exactly that chain. A subset would
	// leave a branch sitting on something that has moved out from under it,
	// which is a broken stack presented as a completed reorder.
	const chain = new Set(desired);
	const orphaned = branches.filter(
		(branch) =>
			!chain.has(branch.name) &&
			branch.parent !== undefined &&
			chain.has(branch.parent),
	);
	if (orphaned.length > 0) {
		return {
			kind: "faulted",
			fault: {
				kind: "unknown-parent",
				branches: orphaned.map((branch) => branch.name),
				reason: `${orphaned.map((branch) => branch.name).join(", ")} sits on a branch being reordered but was not named in the new order, so the reorder would leave it behind. Name every branch above the lowest one you are moving.`,
			},
		};
	}

	const steps: ReparentStep[] = [];
	// The new lowest branch inherits whatever the old lowest sat on, since a
	// reorder rearranges a chain rather than relocating it. Topological order
	// is what identifies the old lowest: it is the first of the chain to
	// appear once ancestors come before descendants.
	const anchor = order.branches.find((branch) =>
		chain.has(branch.name),
	)?.parent;
	desired.forEach((name, at) => {
		const parent = at === 0 ? anchor : desired[at - 1];
		const current = branches.find((branch) => branch.name === name)?.parent;
		if (current === parent) return;
		steps.push({ branch: name, ...(parent === undefined ? {} : { parent }) });
	});

	return { kind: "planned", steps };
}

/**
 * Whether pointing a branch at a new parent still leaves a stack.
 *
 * Checked before anything runs, because the failure is silent: a branch made
 * its own ancestor still rebases, and produces a repository where a restack
 * never terminates.
 */
export function reparentFault(
	branches: readonly StackedBranch[],
	name: string,
	parent: string | undefined,
): StackFault | undefined {
	if (parent === undefined) return undefined;
	if (parent === name) {
		return {
			kind: "cycle",
			branches: [name],
			reason: `${name} cannot sit on itself.`,
		};
	}
	if (!branches.some((branch) => branch.name === name)) {
		return {
			kind: "unknown-parent",
			branches: [name],
			reason: `${name} is not tracked in this stack.`,
		};
	}
	if (!branches.some((branch) => branch.name === parent)) {
		return {
			kind: "unknown-parent",
			branches: [parent],
			reason: `${parent} is not tracked in this stack, so nothing can be stacked on it yet. Track it first.`,
		};
	}
	if (descendantsOf(branches, name).includes(parent)) {
		return {
			kind: "cycle",
			branches: [name, parent],
			reason: `${parent} already sits above ${name}, so putting ${name} on it would close a loop.`,
		};
	}
	return undefined;
}

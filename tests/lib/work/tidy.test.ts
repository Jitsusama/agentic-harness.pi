import { describe, expect, it } from "vitest";
import {
	type OrphanAsk,
	orphanedTrees,
	tidyPlan,
	type WorktreeOnDisk,
} from "../../../lib/work/tidy.js";

/** A tree sitting on trunk with one merged branch beside it. */
const AFTER_A_MERGE = {
	trunk: "main",
	current: "main",
	branches: [
		{ name: "main", mergedIntoTrunk: true },
		{
			name: "add-widget",
			mergedIntoTrunk: true,
			tracking: "origin/add-widget",
		},
	],
};

describe("what has been spent", () => {
	it("offers a merged branch", () => {
		const plan = tidyPlan(AFTER_A_MERGE);

		expect(plan.removable).toEqual([
			{ branch: "add-widget", alsoUntrack: false },
		]);
	});

	it("says a tracked branch has to be forgotten too", () => {
		const plan = tidyPlan({ ...AFTER_A_MERGE, tracked: ["add-widget"] });

		expect(plan.removable).toEqual([
			{ branch: "add-widget", alsoUntrack: true },
		]);
	});

	// Excluded before merge state is even considered, so no confusion
	// further down can propose either of them.
	it("never offers the trunk, however merged it is", () => {
		const plan = tidyPlan(AFTER_A_MERGE);

		expect(plan.removable.map((r) => r.branch)).not.toContain("main");
		expect(plan.keeping).toContainEqual({
			branch: "main",
			why: "it is the trunk",
		});
	});

	it("never offers the branch checked out here", () => {
		const plan = tidyPlan({ ...AFTER_A_MERGE, current: "add-widget" });

		expect(plan.removable).toEqual([]);
		expect(plan.keeping.at(-1)?.why).toContain("move off it first");
	});

	it("keeps a branch trunk has not taken, and says so", () => {
		const plan = tidyPlan({
			...AFTER_A_MERGE,
			branches: [{ name: "wip", mergedIntoTrunk: false }],
		});

		expect(plan.removable).toEqual([]);
		expect(plan.keeping).toEqual([
			{ branch: "wip", why: "main does not contain it yet" },
		]);
	});
});

describe("a branch whose remote is gone but which trunk does not contain", () => {
	const squashed = {
		trunk: "main",
		current: "main",
		branches: [
			{
				name: "add-widget",
				mergedIntoTrunk: false,
				tracking: "origin/add-widget",
				remoteGone: true,
			},
		],
	};

	// The case the whole module slows down for. A squash merge lands the
	// work as a new commit, so git will not call the branch merged, and
	// the remote branch is gone because the merge removed it. That is
	// indistinguishable from unmerged work whose branch somebody deleted,
	// and deleting it needs -D, which throws the commits away.
	it("refuses to offer it, since -d would refuse and -D would lose it", () => {
		const plan = tidyPlan(squashed);

		expect(plan.removable).toEqual([]);
	});

	it("marks it as a call for a person rather than a refusal", () => {
		const plan = tidyPlan(squashed);

		expect(plan.keeping[0]?.decide).toBe(true);
	});

	it("names both readings, since they are indistinguishable from here", () => {
		const plan = tidyPlan(squashed);

		expect(plan.keeping[0]?.why).toContain("squash merge");
		expect(plan.keeping[0]?.why).toContain("losing work");
		expect(plan.keeping[0]?.why).toContain("origin/add-widget");
	});

	it("reports that there are refs worth pruning", () => {
		expect(tidyPlan(squashed).prunable).toBe(true);
		expect(tidyPlan(AFTER_A_MERGE).prunable).toBe(false);
	});
});

describe("trees left behind", () => {
	const main = "/repo";
	const ask = (
		worktrees: WorktreeOnDisk[],
		remembered: string[] = [],
	): OrphanAsk => ({ mainPath: main, worktrees, remembered });

	it("never offers the checkout the others hang off", () => {
		const plan = orphanedTrees(ask([{ path: main, mergedIntoTrunk: true }]));

		expect(plan.reclaimable).toEqual([]);
		expect(plan.retained[0]?.why).toContain("hang off");
	});

	it("offers a merged tree nothing holds", () => {
		const plan = orphanedTrees(
			ask([
				{ path: main },
				{
					path: "/repo/.worktrees/old",
					branch: "plan-1",
					mergedIntoTrunk: true,
				},
			]),
		);

		expect(plan.reclaimable).toEqual([
			{ path: "/repo/.worktrees/old", branch: "plan-1" },
		]);
	});

	it("sends a tree something still holds back to its holder", () => {
		const held = { path: "/repo/.worktrees/live", mergedIntoTrunk: true };
		const plan = orphanedTrees(ask([{ path: main }, held], [held.path]));

		expect(plan.reclaimable).toEqual([]);
		const kept = plan.retained.at(-1)?.why ?? "";
		expect(kept).toContain("give it back");
		// Never named, because the broker is one holder among several and
		// a quest is the common other. Blaming the broker for a quest's
		// tree sends the reader to the wrong verb.
		expect(kept).not.toContain("broker");
	});

	it("refuses a dirty tree outright, ahead of merge state", () => {
		const plan = orphanedTrees(
			ask([
				{ path: main },
				{ path: "/repo/.worktrees/wip", dirty: true, mergedIntoTrunk: true },
			]),
		);

		expect(plan.reclaimable).toEqual([]);
		const kept = plan.retained.at(-1);
		expect(kept?.why).toContain("uncommitted");
		// A refusal, not something for a person to weigh up.
		expect(kept?.decide).toBeUndefined();
	});

	it("puts a tree nobody's name is on to a person, not to a rule", () => {
		// Every record written before the broker stamped an owner. There
		// is no sound way to attribute one after the fact: the machine
		// has not rebooted since they were written, so nothing can be
		// ruled out that way, and an age threshold reclaims a live
		// session's tree the first time somebody leaves one open over a
		// weekend. Neither held nor reclaimable, and self-clearing.
		const path = "/repo/.worktrees/from-before";
		const plan = orphanedTrees({
			...ask([{ path: main }, { path, mergedIntoTrunk: true }]),
			unattributed: [path],
		});

		// Merged and unheld, so the rules alone would have reclaimed it.
		expect(plan.reclaimable).toEqual([]);
		const kept = plan.retained.at(-1);
		expect(kept?.decide).toBe(true);
		expect(kept?.why).toContain("who cut it");
	});

	it("lets a live claim outrank a record with nobody's name on it", () => {
		// The ordering, which is the whole safety of the pair and which
		// the case above cannot see, since it leaves the claim set empty.
		// A quest holds trees against a piece of work and says so over
		// the bus: that is something running making a positive statement,
		// where an unattributed record is the absence of one. Asked in
		// the wrong order, the claim was downgraded to a decision and a
		// tree somebody had just claimed joined the list a person is
		// invited to clear.
		const path = "/repo/.worktrees/claimed";
		const plan = orphanedTrees({
			...ask([{ path: main }, { path, mergedIntoTrunk: true }], [path]),
			unattributed: [path],
		});

		const kept = plan.retained.at(-1);
		expect(kept?.why).toContain("still holds it");
		expect(kept?.decide).toBeUndefined();
	});

	it("names both readings when nothing can prove the work landed", () => {
		const plan = orphanedTrees(
			ask([{ path: main }, { path: "/repo/.worktrees/x", branch: "plan-9" }]),
		);

		const kept = plan.retained.at(-1);
		expect(kept?.decide).toBe(true);
		expect(kept?.why).toContain("squash");
		expect(kept?.why).toContain("only copy");
	});
});

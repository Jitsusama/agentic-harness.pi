import { describe, expect, it } from "vitest";
import { tidyPlan } from "../../../lib/work/tidy.js";

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

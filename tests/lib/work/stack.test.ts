/**
 * Thinking about a stack, without a repository.
 *
 * These are the answers a stacked workflow is built on, and every one of them
 * is a place stacked tooling goes wrong: replaying out of order, replaying
 * without a boundary so commits duplicate, and moves that leave something which
 * is not a stack at all.
 */

import { describe, expect, it } from "vitest";
import {
	descendantsOf,
	orderStack,
	planReorder,
	planRestack,
	reparentFault,
	type StackedBranch,
} from "../../../lib/work/stack.js";

/** A three-high stack: `a` on trunk, `b` on `a`, `c` on `b`. */
const chain: StackedBranch[] = [
	{ name: "a", base: "trunk1" },
	{ name: "b", parent: "a", base: "a1" },
	{ name: "c", parent: "b", base: "b1" },
];

/** Names only, for comparing an ordering. */
function names(branches: readonly StackedBranch[]): string[] {
	return branches.map((branch) => branch.name);
}

describe("ordering a stack", () => {
	it("puts each branch after whatever it sits on", () => {
		// Out of order is worse than not running: replaying a child before its
		// parent moves aligns it to a base about to stop existing.
		const order = orderStack([chain[2], chain[0], chain[1]]);

		expect(order.kind).toBe("ordered");
		if (order.kind !== "ordered") return;
		expect(names(order.branches)).toEqual(["a", "b", "c"]);
	});

	it("keeps siblings in the order they were given", () => {
		// Nothing here can rank two branches on the same parent, and inventing
		// a rank would make a restack depend on a detail nobody chose.
		const order = orderStack([
			{ name: "a" },
			{ name: "second", parent: "a" },
			{ name: "first", parent: "a" },
		]);

		if (order.kind !== "ordered") throw new Error("expected an ordering");
		expect(names(order.branches)).toEqual(["a", "second", "first"]);
	});

	it("reports a cycle rather than looping", () => {
		const order = orderStack([
			{ name: "a", parent: "c" },
			{ name: "b", parent: "a" },
			{ name: "c", parent: "b" },
		]);

		expect(order).toMatchObject({ kind: "faulted" });
		if (order.kind !== "faulted") return;
		expect(order.fault.kind).toBe("cycle");
		expect(order.fault.branches).toContain("a");
	});

	it("names a parent that is not tracked, and says both ways out", () => {
		const order = orderStack([{ name: "b", parent: "a" }]);

		if (order.kind !== "faulted") throw new Error("expected a fault");
		expect(order.fault.kind).toBe("unknown-parent");
		expect(order.fault.reason).toContain("Track it");
	});

	it("refuses a branch recorded twice", () => {
		const order = orderStack([{ name: "a" }, { name: "a", parent: "b" }]);

		expect(order).toMatchObject({ kind: "faulted" });
		if (order.kind !== "faulted") return;
		expect(order.fault.kind).toBe("duplicate");
	});
});

describe("what sits above a branch", () => {
	it("finds descendants however far up", () => {
		expect(descendantsOf(chain, "a")).toEqual(["b", "c"]);
		expect(descendantsOf(chain, "b")).toEqual(["c"]);
		expect(descendantsOf(chain, "c")).toEqual([]);
	});
});

describe("planning a restack", () => {
	it("carries the base each branch was last aligned at", () => {
		// Replaying without it hands the branch every commit its parent
		// already has, which is the duplicated-commit mess that makes people
		// abandon stacks.
		const plan = planRestack(chain, "main");

		expect(plan.kind).toBe("planned");
		if (plan.kind !== "planned") return;
		expect(plan.steps).toEqual([
			{ branch: "a", onto: "main", from: "trunk1" },
			{ branch: "b", onto: "a", from: "a1" },
			{ branch: "c", onto: "b", from: "b1" },
		]);
	});

	it("puts a root onto trunk and everything else onto its parent", () => {
		const plan = planRestack([{ name: "solo" }], "main");

		if (plan.kind !== "planned") throw new Error("expected a plan");
		expect(plan.steps[0]).toMatchObject({ branch: "solo", onto: "main" });
	});

	it("still plans a branch whose base was never recorded", () => {
		// The adapter falls back to a merge-base, which is a guess, but one
		// made and reported at replay time beats refusing to replay a branch
		// somebody tracked by hand.
		const plan = planRestack(
			[{ name: "a" }, { name: "b", parent: "a" }],
			"main",
		);

		if (plan.kind !== "planned") throw new Error("expected a plan");
		expect(plan.steps[1]).toEqual({ branch: "b", onto: "a" });
		expect(plan.steps[1]).not.toHaveProperty("from");
	});

	it("passes a fault straight through rather than planning nonsense", () => {
		const plan = planRestack([{ name: "a", parent: "a" }], "main");

		expect(plan).toMatchObject({ kind: "faulted" });
	});
});

describe("planning a reorder", () => {
	it("expresses a swap as the parentage it implies", () => {
		const plan = planReorder(chain, ["a", "c", "b"]);

		if (plan.kind !== "planned") throw new Error("expected a plan");
		expect(plan.steps).toEqual([
			{ branch: "c", parent: "a" },
			{ branch: "b", parent: "c" },
		]);
	});

	it("leaves the chain sitting where it sat", () => {
		// A reorder rearranges a chain rather than relocating it, so the new
		// lowest branch inherits what the old lowest sat on.
		const onTop: StackedBranch[] = [
			{ name: "x" },
			{ name: "a", parent: "x" },
			{ name: "b", parent: "a" },
		];

		const plan = planReorder(onTop, ["b", "a"]);

		if (plan.kind !== "planned") throw new Error("expected a plan");
		expect(plan.steps).toEqual([
			{ branch: "b", parent: "x" },
			{ branch: "a", parent: "b" },
		]);
	});

	it("moves a branch to the bottom of a trunk-rooted chain", () => {
		const plan = planReorder(chain, ["c", "a", "b"]);

		if (plan.kind !== "planned") throw new Error("expected a plan");
		// `c` becomes the root, so it carries no parent at all.
		expect(plan.steps[0]).toEqual({ branch: "c" });
		expect(plan.steps).toContainEqual({ branch: "a", parent: "c" });
	});

	it("says nothing needs doing when the order asked for is the order held", () => {
		const plan = planReorder(chain, ["a", "b", "c"]);

		if (plan.kind !== "planned") throw new Error("expected a plan");
		expect(plan.steps).toEqual([]);
	});

	it("refuses to leave a branch behind", () => {
		// Reordering a subset would leave whatever sat above it on a branch
		// that has moved, which is a broken stack presented as a finished job.
		const plan = planReorder(chain, ["a", "b"]);

		expect(plan).toMatchObject({ kind: "faulted" });
		if (plan.kind !== "faulted") return;
		expect(plan.fault.branches).toContain("c");
		expect(plan.fault.reason).toContain("Name every branch");
	});

	it("refuses a branch named twice, and one it has never heard of", () => {
		expect(planReorder(chain, ["a", "b", "b"])).toMatchObject({
			kind: "faulted",
			fault: { kind: "duplicate" },
		});
		expect(planReorder(chain, ["a", "b", "c", "d"])).toMatchObject({
			kind: "faulted",
			fault: { kind: "unknown-parent" },
		});
	});
});

describe("checking a reparent before it runs", () => {
	it("permits a move that leaves a stack", () => {
		expect(reparentFault(chain, "c", "a")).toBeUndefined();
		expect(reparentFault(chain, "c", undefined)).toBeUndefined();
	});

	it("refuses a branch onto itself", () => {
		expect(reparentFault(chain, "a", "a")).toMatchObject({ kind: "cycle" });
	});

	it("refuses a branch onto its own descendant", () => {
		// The failure is silent otherwise: this still rebases, and produces a
		// repository where a restack never terminates.
		const fault = reparentFault(chain, "a", "c");

		expect(fault).toMatchObject({ kind: "cycle" });
		expect(fault?.reason).toContain("above");
	});

	it("refuses an untracked parent, and says to track it", () => {
		const fault = reparentFault(chain, "c", "nope");

		expect(fault).toMatchObject({ kind: "unknown-parent" });
		expect(fault?.reason).toContain("Track it");
	});
});

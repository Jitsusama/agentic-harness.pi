/**
 * Working out which changes in a stack point at the wrong base.
 *
 * The decision is kept apart from the doing because the doing differs
 * by backend, and this is the part that does not: whatever moves the
 * changes, the same nodes need moving and the same ones must be left
 * alone.
 */

import { describe, expect, it } from "vitest";
import type { Proposal, Stack, StackNode } from "../../../lib/review/index.js";
import { retargetPlan, retargetRoute } from "../../../lib/review/index.js";

/** A proposal that targets `base`, with the rest filled in plausibly. */
function proposedOnto(base: string): Proposal {
	return {
		ref: { kind: "proposal", id: base, label: `#${base}` },
		title: "Something",
		body: "",
		state: "open",
		draft: false,
		author: { id: "1", login: "someone" },
		base,
		head: "whatever",
	} as unknown as Proposal;
}

function stackOf(...nodes: StackNode[]): Stack {
	return { provenance: "authoritative", trunk: "main", nodes };
}

describe("which changes point at the wrong base", () => {
	it("moves a change whose parent has moved out from under it", () => {
		// The everyday case: the bottom of the stack landed, so the one
		// above it now sits on trunk while its change still targets the
		// branch that merged.
		const plan = retargetPlan(
			stackOf(
				{ ref: "middle", parent: "main", proposal: proposedOnto("bottom") },
				{ ref: "top", parent: "middle", proposal: proposedOnto("middle") },
			),
		);

		expect(plan.moves).toEqual([{ ref: "middle", from: "bottom", to: "main" }]);
	});

	it("leaves a change that already targets its parent", () => {
		const plan = retargetPlan(
			stackOf({
				ref: "top",
				parent: "middle",
				proposal: proposedOnto("middle"),
			}),
		);

		expect(plan.moves).toEqual([]);
	});

	it("leaves a root alone rather than pointing it at the trunk", () => {
		// A root proposed against a release branch is somebody's
		// decision, and moving it to trunk asks a different team to look.
		const plan = retargetPlan(
			stackOf({ ref: "bottom", proposal: proposedOnto("release-25") }),
		);

		expect(plan.moves).toEqual([]);
		expect(plan.skipped[0]?.why).toContain("root");
	});

	it("says a branch with nothing proposed on it is a fact, not a problem", () => {
		const plan = retargetPlan(stackOf({ ref: "middle", parent: "bottom" }));

		expect(plan.moves).toEqual([]);
		expect(plan.skipped[0]?.why).toContain("nothing is proposed");
	});
});

describe("who carries out a retarget", () => {
	const edit = { edit: async () => proposedOnto("main") } as never;

	it("stands aside for a backend that holds the stack itself", () => {
		const route = retargetRoute({ restack: () => {} }, edit);

		expect("kind" in route && route.kind).toBe("native");
		expect("why" in route && route.why).toContain("moves as one");
	});

	it("walks the changes for a backend with no stack operation", () => {
		const route = retargetRoute(undefined, edit);

		expect("kind" in route && route.kind).toBe("per-change");
	});

	it("prefers the native route when a backend offers both", () => {
		// A backend that can do either must not be walked change by
		// change: moving one without the others leaves its own model
		// inconsistent, which is the reason it has the operation at all.
		const route = retargetRoute({ restack: () => {} }, edit);

		expect("kind" in route && route.kind).toBe("native");
	});

	it("refuses when a backend can do neither, naming what to do", () => {
		const route = retargetRoute(undefined, undefined);

		expect("refusal" in route).toBe(true);
		expect("refusal" in route && route.refusal).toContain("no way to retarget");
	});
});

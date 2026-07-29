/**
 * Projecting the substrate's topology onto the stack this
 * workflow shows.
 *
 * The two disagree about what a stack is. The substrate reports a
 * flattened tree of refs, some of which nobody has proposed; this
 * workflow shows a chain of pull requests with a cursor in it.
 * Every test here pins one step of that narrowing.
 */

import { describe, expect, it } from "vitest";
import { stackViewFrom } from "../../../extensions/pr-workflow/stack.js";
import type {
	Proposal,
	StackNode,
	Stack as Topology,
} from "../../../lib/review/index.js";
import { githubChange } from "../../../lib/review/index.js";

function proposalOn(number: number, base: string, head: string): Proposal {
	return {
		ref: {
			provider: "github",
			repo: { key: "github:o/r" },
			id: String(number),
			label: `o/r#${number}`,
		},
		title: `PR ${number}`,
		body: "",
		state: "open",
		draft: false,
		author: { id: "octocat" },
		base,
		head,
	};
}

/** A node carrying a proposal, the ordinary case. */
function node(number: number, ref: string, parent?: string): StackNode {
	return {
		ref,
		...(parent ? { parent } : {}),
		proposal: proposalOn(number, parent ?? "main", ref),
	};
}

describe("stackViewFrom", () => {
	it("orders a chain parent to child and marks where the cursor is", () => {
		const topology: Topology = {
			provenance: "derived",
			nodes: [node(1, "one"), node(2, "two", "one"), node(3, "three", "two")],
			cursor: 1,
		};

		const stack = stackViewFrom(topology);

		expect(stack.entries.map((e) => e.reference.number)).toEqual([1, 2, 3]);
		expect(stack.cursorIndex).toBe(1);
		expect(stack.entries[1]).toEqual({
			// The change comes through as well as its projection, so a
			// sibling in the stack can be reached on the system that
			// hosts it rather than a guessed one.
			change: githubChange({ key: "github:o/r" }, "2"),
			reference: { owner: "o", repo: "r", number: 2 },
			title: "PR 2",
			baseRefName: "one",
			headRefName: "two",
		});
	});

	it("drops a ref nobody has proposed, since this view shows pull requests", () => {
		// The substrate reports a branch with no proposal as a node,
		// because a stack of unproposed branches is still a stack.
		// This view has no way to name one.
		const unproposed: StackNode = { ref: "two", parent: "one" };
		const topology: Topology = {
			provenance: "derived",
			nodes: [node(1, "one"), unproposed, node(3, "three", "two")],
			cursor: 2,
		};

		const stack = stackViewFrom(topology);

		expect(stack.entries.map((e) => e.reference.number)).toEqual([1, 3]);
		// The cursor still points at the change it pointed at, not at
		// whatever slid into that index once a node was dropped.
		expect(stack.cursorIndex).toBe(1);
	});

	it("keeps the cursor's lineage and sets fan-out aside", () => {
		// Two children of the cursor is a fan-out. The chain cannot
		// contain both, and picking one silently would assert a
		// parentage nobody stated.
		const topology: Topology = {
			provenance: "derived",
			nodes: [
				node(1, "one"),
				node(2, "two", "one"),
				node(3, "three", "two"),
				node(4, "four", "two"),
			],
			cursor: 1,
		};

		const stack = stackViewFrom(topology);

		expect(stack.entries.map((e) => e.reference.number)).toEqual([1, 2]);
		expect(stack.cursorIndex).toBe(1);
		expect(stack.cursorChildren.map((e) => e.reference.number)).toEqual([3, 4]);
	});

	it("follows a single child rather than calling it a fan-out", () => {
		const topology: Topology = {
			provenance: "derived",
			nodes: [node(1, "one"), node(2, "two", "one")],
			cursor: 0,
		};

		const stack = stackViewFrom(topology);

		expect(stack.entries.map((e) => e.reference.number)).toEqual([1, 2]);
		expect(stack.cursorChildren).toEqual([]);
	});

	it("reports a lone change as a stack of one", () => {
		const topology: Topology = {
			provenance: "derived",
			nodes: [node(7, "seven")],
			cursor: 0,
		};

		const stack = stackViewFrom(topology);

		expect(stack.entries.map((e) => e.reference.number)).toEqual([7]);
		expect(stack.cursorIndex).toBe(0);
		expect(stack.cursorChildren).toEqual([]);
	});

	it("terminates on a cycle rather than walking it forever", () => {
		// A provider that reports two refs parented on each other is
		// misbehaving, but a view that hangs on it is worse. Each
		// change appears once and the walk ends.
		const topology: Topology = {
			provenance: "derived",
			nodes: [node(1, "one", "two"), node(2, "two", "one")],
			cursor: 0,
		};

		const stack = stackViewFrom(topology);

		const numbers = stack.entries.map((e) => e.reference.number);
		expect(new Set(numbers).size).toBe(numbers.length);
		expect(numbers).toContain(1);
	});

	it("says nothing rather than guessing when the cursor is unplaced", () => {
		// A provider that will not say where the caller stands leaves
		// no honest chain to draw, and index zero would be a guess.
		const topology: Topology = {
			provenance: "derived",
			nodes: [node(1, "one"), node(2, "two", "one")],
		};

		const stack = stackViewFrom(topology);

		expect(stack.entries).toEqual([]);
		expect(stack.cursorIndex).toBe(-1);
	});
});

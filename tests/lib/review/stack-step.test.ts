import { describe, expect, it } from "vitest";
import type { Stack, StackNode } from "../../../lib/review/stack.js";
import { stackStep } from "../../../lib/review/stack.js";

function node(ref: string, parent?: string): StackNode {
	return parent === undefined ? { ref } : { ref, parent };
}

/** A plain chain: trunk <- one <- two <- three. */
function chain(): Stack {
	return {
		provenance: "authoritative",
		trunk: "main",
		nodes: [node("one", "main"), node("two", "one"), node("three", "two")],
	};
}

/** Two children off the same parent. */
function fanOut(): Stack {
	return {
		provenance: "derived",
		trunk: "main",
		nodes: [node("one", "main"), node("left", "one"), node("right", "one")],
	};
}

describe("stackStep", () => {
	it("moves up to the only child", () => {
		expect(stackStep(chain(), "one", "next")).toEqual({
			kind: "move",
			node: node("two", "one"),
		});
	});

	it("moves down to the parent", () => {
		expect(stackStep(chain(), "two", "prev")).toEqual({
			kind: "move",
			node: node("one", "main"),
		});
	});

	it("reports the tip when nothing sits above", () => {
		expect(stackStep(chain(), "three", "next")).toEqual({
			kind: "edge",
			at: "tip",
		});
	});

	it("reports the root when the parent is the trunk", () => {
		expect(stackStep(chain(), "one", "prev")).toEqual({
			kind: "edge",
			at: "root",
		});
	});

	it("refuses to choose when a node fans out", () => {
		const step = stackStep(fanOut(), "one", "next");

		expect(step).toEqual({
			kind: "choose",
			candidates: [node("left", "one"), node("right", "one")],
		});
	});

	it("still moves down unambiguously from inside a fan-out", () => {
		expect(stackStep(fanOut(), "right", "prev")).toEqual({
			kind: "move",
			node: node("one", "main"),
		});
	});

	it("says so when the stack does not place the ref at all", () => {
		expect(stackStep(chain(), "elsewhere", "next")).toEqual({
			kind: "unplaced",
		});
		expect(stackStep(chain(), "elsewhere", "prev")).toEqual({
			kind: "unplaced",
		});
	});

	it("treats a node whose parent is absent from the stack as the root", () => {
		const orphan: Stack = {
			provenance: "derived",
			nodes: [node("two", "one")],
		};

		expect(stackStep(orphan, "two", "prev")).toEqual({
			kind: "edge",
			at: "root",
		});
	});

	it("reports the tip for a lone node asked to go up", () => {
		const single: Stack = { provenance: "derived", nodes: [node("only")] };

		expect(stackStep(single, "only", "next")).toEqual({
			kind: "edge",
			at: "tip",
		});
	});
});

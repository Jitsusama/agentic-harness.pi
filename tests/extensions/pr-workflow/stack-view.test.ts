import { describe, expect, it } from "vitest";
import type {
	Stack,
	StackEntry,
} from "../../../extensions/pr-workflow/stack.js";
import {
	formatStack,
	nextInStack,
	prevInStack,
} from "../../../extensions/pr-workflow/stack-view.js";

/**
 * Read-only navigation over a discovered stack.
 *
 * `formatStack` renders the chain as prose for the
 * conversation surface. `nextInStack` and `prevInStack`
 * are pure walkers — they return the adjacent entry
 * without performing any I/O. The action handlers (in
 * index.ts) call these and then re-invoke loadPr for
 * the new cursor.
 */

function entry(number: number, head: string, base: string): StackEntry {
	return {
		reference: { owner: "o", repo: "r", number },
		title: `PR #${number}`,
		headRefName: head,
		baseRefName: base,
	};
}

describe("formatStack", () => {
	it("renders parent \u2192 child with the cursor highlighted", () => {
		const stack: Stack = {
			entries: [
				entry(40, "feat/a", "main"),
				entry(41, "feat/b", "feat/a"),
				entry(42, "feat/c", "feat/b"),
			],
			cursorIndex: 1,
			cursorChildren: [],
		};
		const rendered = formatStack(stack);
		// Three lines, one per entry, in order.
		const lines = rendered.split("\n").filter((l) => l.trim().length > 0);
		expect(lines).toHaveLength(3);
		// Cursor row marked distinctly.
		const cursorLine = lines.find((l) => l.includes("#41"));
		expect(cursorLine).toMatch(/\\u2192|->|cursor|\u25b6/i);
	});

	it("renders branch metadata so the user can see the chain visually", () => {
		const stack: Stack = {
			entries: [entry(40, "feat/a", "main"), entry(41, "feat/b", "feat/a")],
			cursorIndex: 1,
			cursorChildren: [],
		};
		const rendered = formatStack(stack);
		expect(rendered).toContain("feat/a");
		expect(rendered).toContain("feat/b");
		expect(rendered).toContain("main");
	});

	it("calls out fan-out children when the cursor has multiple downstream PRs", () => {
		// Linear stack only walks one child; if the
		// cursor branches, the others are reported in
		// `cursorChildren` and need a visible footer so
		// the user knows the tree isn't a line.
		const stack: Stack = {
			entries: [entry(40, "feat/a", "main")],
			cursorIndex: 0,
			cursorChildren: [
				entry(41, "feat/x", "feat/a"),
				entry(42, "feat/y", "feat/a"),
			],
		};
		const rendered = formatStack(stack);
		expect(rendered).toMatch(/fan.?out|branches|children/i);
		expect(rendered).toContain("#41");
		expect(rendered).toContain("#42");
	});

	it("handles a singleton stack (the cursor is the only entry)", () => {
		const stack: Stack = {
			entries: [entry(40, "feat/a", "main")],
			cursorIndex: 0,
			cursorChildren: [],
		};
		const rendered = formatStack(stack);
		expect(rendered).toContain("#40");
		expect(rendered).not.toMatch(/fan.?out|branches/i);
	});
});

describe("nextInStack", () => {
	it("returns the child of the cursor when there is one", () => {
		const stack: Stack = {
			entries: [
				entry(40, "feat/a", "main"),
				entry(41, "feat/b", "feat/a"),
				entry(42, "feat/c", "feat/b"),
			],
			cursorIndex: 1,
			cursorChildren: [],
		};
		expect(nextInStack(stack)?.reference.number).toBe(42);
	});

	it("returns null when the cursor is the last entry", () => {
		const stack: Stack = {
			entries: [entry(40, "feat/a", "main"), entry(41, "feat/b", "feat/a")],
			cursorIndex: 1,
			cursorChildren: [],
		};
		expect(nextInStack(stack)).toBeNull();
	});

	it("returns null when the cursor has fan-out children (no unambiguous next)", () => {
		// If two children exist, \"next\" is ambiguous;
		// the agent has to ask which one.
		const stack: Stack = {
			entries: [entry(40, "feat/a", "main")],
			cursorIndex: 0,
			cursorChildren: [
				entry(41, "feat/x", "feat/a"),
				entry(42, "feat/y", "feat/a"),
			],
		};
		expect(nextInStack(stack)).toBeNull();
	});

	it("prefers fan-out ambiguity over a linear-chain next, even if both fields are present", () => {
		// Defensive: if downstream is BOTH a linear chain
		// (entries continues past cursor) AND a fan-out
		// (cursorChildren populated), refuse to navigate.
		// The walker shouldn't produce this state, but the
		// function shouldn't silently pick one path.
		const stack: Stack = {
			entries: [entry(40, "feat/a", "main"), entry(41, "feat/b", "feat/a")],
			cursorIndex: 0,
			cursorChildren: [
				entry(42, "feat/x", "feat/a"),
				entry(43, "feat/y", "feat/a"),
			],
		};
		expect(nextInStack(stack)).toBeNull();
	});
});

describe("prevInStack", () => {
	it("returns the parent of the cursor when there is one", () => {
		const stack: Stack = {
			entries: [
				entry(40, "feat/a", "main"),
				entry(41, "feat/b", "feat/a"),
				entry(42, "feat/c", "feat/b"),
			],
			cursorIndex: 1,
			cursorChildren: [],
		};
		expect(prevInStack(stack)?.reference.number).toBe(40);
	});

	it("returns null when the cursor is the first entry", () => {
		const stack: Stack = {
			entries: [entry(40, "feat/a", "main"), entry(41, "feat/b", "feat/a")],
			cursorIndex: 0,
			cursorChildren: [],
		};
		expect(prevInStack(stack)).toBeNull();
	});
});

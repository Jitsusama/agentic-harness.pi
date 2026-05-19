import { describe, expect, it } from "vitest";
import {
	buildStack,
	type PrSearch,
	type StackEntry,
} from "../../../extensions/pr-workflow/stack.js";

function entry(
	number: number,
	headRefName: string,
	baseRefName: string,
): StackEntry {
	return {
		reference: { owner: "octo", repo: "demo", number },
		title: `PR ${number}`,
		baseRefName,
		headRefName,
	};
}

/**
 * Build an in-memory `PrSearch` from a list of open PRs.
 * `findByHead(branch)` returns the PR with that head;
 * `findByBase(branch)` returns every PR with that base.
 */
function searchFrom(prs: StackEntry[]): PrSearch {
	return {
		async findByHead(branch) {
			return prs.find((p) => p.headRefName === branch) ?? null;
		},
		async findByBase(branch) {
			return prs.filter((p) => p.baseRefName === branch);
		},
	};
}

describe("buildStack", () => {
	it("returns a solo entry when no parent or child exists", () => {
		// The most common case: a one-off PR onto main. The stack
		// has exactly one entry and the cursor points at it.
		const cursor = entry(1, "feature/x", "main");
		const search = searchFrom([]);
		return buildStack(cursor, search).then((stack) => {
			expect(stack.entries).toEqual([cursor]);
			expect(stack.cursorIndex).toBe(0);
		});
	});

	it("walks one level upstream to find a parent", () => {
		// cursor's base is the head of another open PR. That PR
		// is the parent; entries come out ordered parent → cursor.
		const parent = entry(10, "feature/a", "main");
		const cursor = entry(11, "feature/b", "feature/a");
		const search = searchFrom([parent]);
		return buildStack(cursor, search).then((stack) => {
			expect(stack.entries.map((e) => e.reference.number)).toEqual([10, 11]);
			expect(stack.cursorIndex).toBe(1);
		});
	});

	it("walks one level downstream to find a child", () => {
		// cursor's head is the base of another open PR. That PR
		// is the child; entries come out ordered cursor → child.
		const cursor = entry(20, "feature/a", "main");
		const child = entry(21, "feature/b", "feature/a");
		const search = searchFrom([child]);
		return buildStack(cursor, search).then((stack) => {
			expect(stack.entries.map((e) => e.reference.number)).toEqual([20, 21]);
			expect(stack.cursorIndex).toBe(0);
		});
	});

	it("places the cursor in the middle of a three-level stack", () => {
		// parent → cursor → child. The cursor index points at the
		// middle entry regardless of how the stack was discovered.
		const parent = entry(30, "feature/a", "main");
		const cursor = entry(31, "feature/b", "feature/a");
		const child = entry(32, "feature/c", "feature/b");
		const search = searchFrom([parent, child]);
		return buildStack(cursor, search).then((stack) => {
			expect(stack.entries.map((e) => e.reference.number)).toEqual([
				30, 31, 32,
			]);
			expect(stack.cursorIndex).toBe(1);
		});
	});

	it("walks several levels in both directions", () => {
		// A four-deep stack with the cursor at position 2. The
		// walker keeps going as long as each step finds exactly
		// one neighbour.
		const a = entry(40, "feature/a", "main");
		const b = entry(41, "feature/b", "feature/a");
		const c = entry(42, "feature/c", "feature/b");
		const d = entry(43, "feature/d", "feature/c");
		const search = searchFrom([a, b, d]);
		return buildStack(c, search).then((stack) => {
			expect(stack.entries.map((e) => e.reference.number)).toEqual([
				40, 41, 42, 43,
			]);
			expect(stack.cursorIndex).toBe(2);
		});
	});

	it("stops walking down at a fan-out and reports the cursor's children", () => {
		// When the cursor has multiple children, "the stack" is
		// ambiguous downstream. We surface the children list so
		// the agent can talk about them, but stop walking deeper.
		const cursor = entry(50, "feature/a", "main");
		const child1 = entry(51, "feature/b1", "feature/a");
		const child2 = entry(52, "feature/b2", "feature/a");
		const search = searchFrom([child1, child2]);
		return buildStack(cursor, search).then((stack) => {
			expect(stack.entries.map((e) => e.reference.number)).toEqual([50]);
			expect(stack.cursorIndex).toBe(0);
			expect(stack.cursorChildren.map((e) => e.reference.number)).toEqual([
				51, 52,
			]);
		});
	});

	it("respects maxDepth in each direction", () => {
		// A pathological 10-deep stack should be capped so the
		// walker can't spin forever in a misconfigured repo.
		const chain: StackEntry[] = [];
		for (let i = 0; i < 10; i++) {
			const head = `feature/${i}`;
			const base = i === 0 ? "main" : `feature/${i - 1}`;
			chain.push(entry(100 + i, head, base));
		}
		const cursor = chain[5];
		const others = chain.filter((_, i) => i !== 5);
		const search = searchFrom(others);
		return buildStack(cursor, search, { maxDepth: 2 }).then((stack) => {
			// 2 upstream + cursor + 2 downstream = 5 entries.
			expect(stack.entries).toHaveLength(5);
			expect(stack.cursorIndex).toBe(2);
		});
	});

	it("breaks cycles defensively", () => {
		// If a misbehaving repo links PR refs in a loop, the
		// walker must terminate AND must not visit the same PR
		// twice. A two-node cycle should produce a stack with
		// each PR appearing exactly once.
		const a = entry(60, "feature/a", "feature/b");
		const b = entry(61, "feature/b", "feature/a");
		const search = searchFrom([a, b]);
		return buildStack(a, search).then((stack) => {
			const numbers = stack.entries.map((e) => e.reference.number);
			expect(numbers).toContain(60);
			// No PR number appears more than once.
			expect(new Set(numbers).size).toBe(numbers.length);
			// And the total stack is bounded: walking the cycle
			// finds at most the two nodes plus nothing extra.
			expect(stack.entries.length).toBeLessThanOrEqual(2);
		});
	});
});

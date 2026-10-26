import { describe, expect, it } from "vitest";
import { heldNames, surveyTarget } from "../../../lib/core/work/index.ts";

const held = (...keys: string[]) => keys.map((key) => ({ key }));

describe("naming what is held", () => {
	it("says none are held when none are", () => {
		expect(heldNames([], "fix-410")).toBe("none are held");
	});

	it("names every tree when there are only a few", () => {
		expect(heldNames(held("a-one", "b-two"))).toBe("a-one, b-two");
	});

	it("names at most five and counts the rest", () => {
		const many = held(...Array.from({ length: 40 }, (_, i) => `tree-${i}`));
		expect(heldNames(many)).toBe(
			"tree-0, tree-1, tree-2, tree-3, tree-4, and 35 more; action trees lists them",
		);
	});

	it("names the trees closest to the name asked for first", () => {
		const many = held(
			...Array.from({ length: 20 }, (_, i) => `snapshot-world-${i}`),
			"worktree-harness-fix-journey",
		);
		expect(heldNames(many, "harness-journey")).toMatch(
			/^worktree-harness-fix-journey, snapshot-world-0,/,
		);
	});

	it("keeps a survey's refusal short however many trees are held", () => {
		const target = surveyTarget({
			tree: "no-such-tree",
			held: Array.from({ length: 200 }, (_, i) => ({
				key: `worktree-github-example-${i}`,
				path: `/nowhere/${i}`,
			})),
			cwd: "/nowhere",
			gitRootOf: () => null,
		});
		expect(target.ok).toBe(false);
		if (target.ok) return;
		expect(target.refusal).toContain("and 195 more; action trees lists them");
		expect(target.refusal.length).toBeLessThan(400);
	});
});

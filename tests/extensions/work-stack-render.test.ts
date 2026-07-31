/**
 * How a stack reads.
 *
 * A listing that only names branches has thrown away the one fact that makes it
 * a stack, so these tests are about the shape being visible rather than about
 * the words. The rendering is the feature here: parentage has no representation
 * in git, which is exactly why it has to be drawn.
 */

import { describe, expect, it } from "vitest";
import { GLYPH } from "../../extensions/work-integration/render.js";
import { stackLines } from "../../extensions/work-integration/tools/stack.js";
import type { StackedBranch } from "../../lib/work/index.js";

const chain: StackedBranch[] = [
	{ name: "a" },
	{ name: "b", parent: "a" },
	{ name: "c", parent: "b" },
];

describe("drawing a stack", () => {
	it("carries parentage in the indentation", () => {
		const lines = stackLines(chain);

		expect(lines[0].startsWith(GLYPH.named)).toBe(true);
		expect(lines[1].startsWith("  ")).toBe(true);
		expect(lines[2].startsWith("    ")).toBe(true);
	});

	it("marks where you are, and marks it by shape not only by words", () => {
		// A stack you cannot locate yourself in is a diagram rather than a tool.
		const lines = stackLines(chain, { on: "b" });

		expect(lines[1]).toContain(GLYPH.tree);
		expect(lines[1]).toContain("you are here");
		expect(lines[0]).toContain(GLYPH.named);
		expect(lines[0]).not.toContain("you are here");
	});

	it("says what the root sits on when trunk is known", () => {
		const lines = stackLines(chain, { trunk: "main" });

		expect(lines[0]).toContain("on main");
		// Only the root sits on trunk; saying it on every row would be noise.
		expect(lines[1]).not.toContain("on main");
	});

	it("flags a branch that needs replaying", () => {
		const lines = stackLines(chain, { drifted: ["b"] });

		expect(lines[1]).toContain("needs replaying");
		expect(lines[0]).not.toContain("needs replaying");
	});

	it("orders siblings under the same parent without inventing a rank", () => {
		const lines = stackLines([
			{ name: "a" },
			{ name: "second", parent: "a" },
			{ name: "first", parent: "a" },
		]);

		expect(lines[1]).toContain("second");
		expect(lines[2]).toContain("first");
		// Both are one level in: they are siblings, not a chain.
		expect(lines[1].indexOf(GLYPH.named)).toBe(lines[2].indexOf(GLYPH.named));
	});

	it("reports a fault instead of drawing a shape that is not one", () => {
		const lines = stackLines([
			{ name: "a", parent: "b" },
			{ name: "b", parent: "a" },
		]);

		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain(GLYPH.refused);
	});
});

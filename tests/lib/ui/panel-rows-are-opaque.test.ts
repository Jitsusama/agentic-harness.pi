/**
 * V6 of the validation plan, turned into a structural check.
 *
 * The bleed was fixed once and stayed half broken, and the reason is worth a
 * test of its own. `opaqueRow` was correct and covered by its own unit tests;
 * what leaked was three rows in each renderer pushed straight onto the array,
 * never passing through it. Two were blank separators and one was the padding
 * that stabilizes height while scrolling, which fires only for content taller
 * than the panel: a long PR body, the exact case that was reported.
 *
 * So the rule is not "the helper is right", it is "every row goes through the
 * helper". That is a property of how the file is written rather than of what
 * one call returns, and a panel's rows cannot be read back from outside the
 * closure that builds them, so it is checked as written.
 *
 * If these renderers are ever restructured so rows are assembled by a pure
 * function, replace this with a test that renders a panel and measures every
 * row. That is the better test; it is not currently reachable.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const RENDERERS = ["prompt-single.ts", "prompt-tabbed.ts"];

/** The panel renderers, read as text, since the rule is about how they are written. */
function sourceOf(file: string): string {
	return readFileSync(
		join(import.meta.dirname, "..", "..", "..", "lib", "ui", file),
		"utf8",
	);
}

describe("every row a panel emits goes through the opacity helper", () => {
	for (const file of RENDERERS) {
		it(file, () => {
			const pushes = sourceOf(file)
				.split("\n")
				.map((line, at) => ({ line: line.trim(), at: at + 1 }))
				.filter((one) => one.line.startsWith("lines.push("))
				// The one sanctioned push is the helper's own, inside `add`.
				.filter((one) => !one.line.includes("opaqueRow("))
				.map((one) => `${file}:${one.at} ${one.line}`);

			expect(pushes).toEqual([]);
		});
	}

	it("still defines the helper it is meant to route through", () => {
		// Guards against the check above passing because the renderer stopped
		// using `lines.push` altogether under some later rewrite.
		for (const file of RENDERERS) {
			expect(sourceOf(file)).toContain("opaqueRow(s, width)");
		}
	});
});

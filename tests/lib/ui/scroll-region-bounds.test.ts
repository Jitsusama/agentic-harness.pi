/**
 * V5 of the validation plan: a body longer than the panel has to scroll
 * rather than overflow.
 *
 * The gate's own comment says the payload is shown "whole, however long",
 * and a gate that elides what it is asking you to approve is the gate this
 * surface used to have. "Whole" has to mean reachable by scrolling, not
 * emitted past the bottom of the panel: a panel taller than the screen makes
 * pi extend the working area, which is the growth the overlay exists to
 * prevent and the mechanism its docstring calls the ghost.
 */

import { describe, expect, it } from "vitest";
import { renderScrollRegion } from "../../../lib/ui/scroll-region.js";
import { fakeTheme } from "./fake-theme.js";

const WIDTH = 80;
const BUDGET = 20;

/** A body of distinct, countable lines, so a missing one is named. */
function lines(count: number): string[] {
	return Array.from({ length: count }, (_, at) => `line ${at + 1}`);
}

describe("a body longer than the panel", () => {
	it("is bounded to the budget rather than emitted past it", () => {
		const shown = renderScrollRegion(
			lines(200),
			{ vOffset: 0, hOffset: 0 },
			BUDGET,
			WIDTH,
			fakeTheme(),
		);

		expect(shown.lines).toHaveLength(BUDGET);
		expect(shown.needsVScroll).toBe(true);
	});

	it("says it scrolls, which is what draws the scrollbar", () => {
		const short = renderScrollRegion(
			lines(5),
			{ vOffset: 0, hOffset: 0 },
			BUDGET,
			WIDTH,
			fakeTheme(),
		);

		expect(short.needsVScroll).toBe(false);
	});

	it("reaches the end of the body, so nothing is unreachable", () => {
		// The claim is that the payload is never clipped. That is only true if
		// the last line can be scrolled to.
		const atEnd = renderScrollRegion(
			lines(200),
			{ vOffset: 500, hOffset: 0 },
			BUDGET,
			WIDTH,
			fakeTheme(),
		);

		expect(atEnd.lines.join("\n")).toContain("line 200");
	});

	it("holds the budget at every offset, including past the end", () => {
		for (const vOffset of [0, 1, 90, 180, 181, 500]) {
			const shown = renderScrollRegion(
				lines(200),
				{ vOffset, hOffset: 0 },
				BUDGET,
				WIDTH,
				fakeTheme(),
			);

			expect(shown.lines).toHaveLength(BUDGET);
		}
	});
});

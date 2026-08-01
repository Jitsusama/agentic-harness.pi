/**
 * The tab strip is for tabs.
 *
 * It used to right-align a progress bar inside itself and reserve that
 * width plus four columns of gap, which is what pushed the tabs into an
 * ellipsis on a panel that had room for all of them. Progress through a
 * batch is a session-level fact and the session already has a line for
 * saying what it is doing, so that is where it goes.
 *
 * These tests are about the width, because the width is the argument.
 */

import { describe, expect, it } from "vitest";
import {
	renderProgressBar,
	renderTabStrip,
} from "../../../lib/ui/tab-strip.js";
import { plainTheme } from "./fake-theme.js";

/**
 * The strip as it would be drawn, through a theme that adds no width.
 *
 * These assertions are all about how much fits, so a theme that wraps
 * every run in markers would have the test measuring the double.
 */
function strip(labels: string[], width = 80, current = 0): string {
	return renderTabStrip(
		labels,
		labels.map(() => "pending" as const),
		current,
		width,
		plainTheme(),
	);
}

describe("the tab strip", () => {
	it("draws no progress bar of its own any more", () => {
		const text = strip(["Plan", "V", "F1"]);
		expect(text).not.toContain("/3");
		expect(text).not.toContain("[");
	});

	it("names every tab when they fit", () => {
		const text = strip(["Plan", "V", "F1", "T26"]);
		for (const label of ["Plan", "V", "F1", "T26"]) {
			expect(text).toContain(label);
		}
	});

	it("fits tabs that the reserved progress width used to push out", () => {
		// Seven tabs at a width where the old strip spent 13 columns on a bar
		// and 4 on the gap before it.
		const labels = ["Plan", "V", "F1", "F2", "T26", "T27", "C4"];
		const text = strip(labels, 72);
		for (const label of labels) expect(text).toContain(label);
		expect(text).not.toContain("\u2026");
	});

	it("still elides when there are genuinely too many", () => {
		const many = Array.from({ length: 40 }, (_, at) => `item-${at + 1}`);
		expect(strip(many, 72)).toContain("\u2026");
	});

	it("stays inside the width it is given", () => {
		const labels = ["Plan", "V", "F1", "F2", "T26", "T27", "C4"];
		expect(strip(labels, 40).length).toBeLessThanOrEqual(40);
	});
});

describe("the progress bar, now that it lives on the status line", () => {
	it("reads as a bar and a count", () => {
		expect(renderProgressBar(2, 5)).toBe("\u2593\u2593\u2591\u2591\u2591 2/5");
	});

	it("fills proportionally once the batch outruns the bar", () => {
		// Two of seven is not two fifths of the bar, and drawing it that way
		// would say the batch was further along than it is.
		expect(renderProgressBar(2, 7)).toBe("\u2593\u2591\u2591\u2591\u2591 2/7");
	});

	it("drops the brackets it wore inside the tab strip", () => {
		// They held it apart from the tabs. The status line's own separators
		// do that job, so keeping them would be a fence around nothing.
		expect(renderProgressBar(0, 3)).not.toContain("[");
	});

	it("fills as the batch is worked through", () => {
		expect(renderProgressBar(0, 5)).toContain("\u2591\u2591\u2591\u2591\u2591");
		expect(renderProgressBar(5, 5)).toContain("\u2593\u2593\u2593\u2593\u2593");
	});

	it("scales a batch longer than the bar rather than overflowing", () => {
		const drawn = renderProgressBar(50, 100);
		expect(drawn).toContain("50/100");
		expect(drawn.split(" ")[0]?.length).toBeLessThanOrEqual(10);
	});
});

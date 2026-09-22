import { describe, expect, it } from "vitest";
import { formatCostMeter } from "../../extensions/cost-workflow/meter.js";

describe("formatCostMeter", () => {
	it("says nothing before anything has been spent", () => {
		// A status line is scarce. A segment reading zero earns none of it.
		expect(formatCostMeter({ session: 0, day: 0 })).toBeNull();
	});

	it("states this process's spend against the day's", () => {
		expect(formatCostMeter({ session: 4.213, day: 38.4 })).toBe(
			"\u03a3$4.21 d$38",
		);
	});

	it("keeps cents on a small session figure and drops them on the day", () => {
		// The session number is watched as it moves, so cents matter. The
		// day number is context, and three more characters of it are not
		// worth the width on a line that degrades.
		expect(formatCostMeter({ session: 0.07, day: 1.4 })).toBe(
			"\u03a3$0.07 d$1",
		);
	});

	it("drops the day when it adds nothing over the session", () => {
		// First session of the day: the two figures are the same number
		// printed twice, which is worse than one.
		expect(formatCostMeter({ session: 2.5, day: 2.5 })).toBe("\u03a3$2.50");
	});

	it("shows the day alone when a session has spent nothing yet", () => {
		expect(formatCostMeter({ session: 0, day: 38.4 })).toBe("d$38");
	});

	it("keeps a large session figure readable without cents", () => {
		expect(formatCostMeter({ session: 143.77, day: 210.2 })).toBe(
			"\u03a3$144 d$210",
		);
	});
});

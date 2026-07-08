import { describe, expect, it } from "vitest";
import { formatRunMeter } from "../../../extensions/observability-workflow/index.js";

describe("formatRunMeter", () => {
	it("reads as a cumulative tally, not a live indicator", () => {
		const meter = formatRunMeter(1, 0.0012);
		expect(meter).toBe("\u03a3 1 run \u00b7 $0.001");
		expect(meter).not.toContain("\u2699");
	});

	it("pluralizes runs and sums cost to three decimals", () => {
		expect(formatRunMeter(3, 0.04256)).toBe("\u03a3 3 runs \u00b7 $0.043");
	});

	it("handles the zero-cost case", () => {
		expect(formatRunMeter(2, 0)).toBe("\u03a3 2 runs \u00b7 $0.000");
	});
});

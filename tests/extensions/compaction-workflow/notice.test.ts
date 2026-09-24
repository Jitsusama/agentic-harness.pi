import { describe, expect, it } from "vitest";
import { compactionNotice } from "../../../extensions/compaction-workflow/notice.ts";

const FIRED = {
	fire: true,
	margin: 1.02,
	// pi prices per million tokens, so 1_210_000 price-tokens is $1.21.
	cost: 1_210_000,
	turnsToRepay: 38.4,
};

describe("telling the user why the session is compacting", () => {
	it("names the cost in dollars and the turns that earn it back", () => {
		expect(compactionNotice(265_000, FIRED)).toBe(
			"Compacting at 265k tokens: $1.21 to summarise, earned back after about 38 more turns at this size",
		);
	});

	it("does not print the ratio, which reads 1.0x every time it fires", () => {
		expect(compactionNotice(265_000, FIRED)).not.toMatch(/\dx\b/);
	});

	it("says so when this stretch is one of the logged experiments", () => {
		const draw = { threshold: Math.SQRT2, propensity: 0.05, explored: true };
		expect(compactionNotice(265_000, FIRED, draw)).toBe(
			"Compacting at 265k tokens: $1.21 to summarise, earned back after about 38 more turns at this size. " +
				"This stretch was drawn to compact once savings reach 1.41 times the cost rather than 1, as a logged experiment",
		);
	});

	it("says nothing more when the stretch takes the usual threshold", () => {
		const draw = { threshold: 1, propensity: 0.9, explored: false };
		expect(compactionNotice(265_000, FIRED, draw)).toBe(
			compactionNotice(265_000, FIRED),
		);
	});
});

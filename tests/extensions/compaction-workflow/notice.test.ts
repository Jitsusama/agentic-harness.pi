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
});

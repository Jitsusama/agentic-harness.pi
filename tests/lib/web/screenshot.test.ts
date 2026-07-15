import { describe, expect, it } from "vitest";
import { planTiles } from "../../../lib/web/screenshot.js";

describe("planTiles", () => {
	it("covers a page shorter than one band with a single full-height tile", () => {
		const plan = planTiles(900, { bandHeight: 1500, maxTiles: 8 });
		expect(plan.bands).toEqual([{ y: 0, height: 900 }]);
		expect(plan.truncated).toBe(false);
	});

	it("splits a taller page into stacked bands, the last one short", () => {
		const plan = planTiles(3500, { bandHeight: 1500, maxTiles: 8 });
		expect(plan.bands).toEqual([
			{ y: 0, height: 1500 },
			{ y: 1500, height: 1500 },
			{ y: 3000, height: 500 },
		]);
		expect(plan.truncated).toBe(false);
	});

	it("uses whole bands when the height is an exact multiple", () => {
		const plan = planTiles(3000, { bandHeight: 1500, maxTiles: 8 });
		expect(plan.bands).toEqual([
			{ y: 0, height: 1500 },
			{ y: 1500, height: 1500 },
		]);
		expect(plan.truncated).toBe(false);
	});

	it("stops at the tile ceiling and reports truncation", () => {
		const plan = planTiles(100000, { bandHeight: 1500, maxTiles: 8 });
		expect(plan.bands).toHaveLength(8);
		expect(plan.bands[7]).toEqual({ y: 10500, height: 1500 });
		expect(plan.truncated).toBe(true);
	});
});

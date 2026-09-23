import { describe, expect, it } from "vitest";
import {
	accumulateReexpansion,
	INITIAL_REEXPANSION,
	reexpansionRate,
} from "../../../lib/demote/index.js";

describe("tracking re-expansion", () => {
	it("starts at zero demotions and zero re-expansions", () => {
		expect(INITIAL_REEXPANSION).toEqual({ demoted: 0, reexpanded: 0 });
	});

	it("counts a demotion without counting it as a re-expansion", () => {
		const next = accumulateReexpansion(INITIAL_REEXPANSION, { demoted: 3 });
		expect(next).toEqual({ demoted: 3, reexpanded: 0 });
	});

	it("counts a re-expansion on top of whatever was already demoted", () => {
		let totals = accumulateReexpansion(INITIAL_REEXPANSION, { demoted: 5 });
		totals = accumulateReexpansion(totals, { reexpanded: 1 });
		expect(totals).toEqual({ demoted: 5, reexpanded: 1 });
	});

	it("reports the rate as reexpanded over demoted, and zero when nothing has been demoted yet", () => {
		expect(reexpansionRate({ demoted: 0, reexpanded: 0 })).toBe(0);
		expect(reexpansionRate({ demoted: 10, reexpanded: 3 })).toBeCloseTo(0.3, 5);
	});
});

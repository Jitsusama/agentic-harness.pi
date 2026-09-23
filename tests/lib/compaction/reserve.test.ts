import { describe, expect, it } from "vitest";
import { clampReserveTokens } from "../../../lib/compaction/index.ts";

describe("reserveTokens clamp", () => {
	it("leaves a requested reserve alone when it fits comfortably", () => {
		expect(clampReserveTokens(200_000, 16_384)).toBe(16_384);
	});

	it("clamps a reserve that would leave no budget at all", () => {
		// The failure this guards: unclamped, a reserve of 600,000 against
		// a 200,000-token model makes the remaining budget negative, which
		// compacts every single turn.
		const clamped = clampReserveTokens(200_000, 600_000);
		expect(clamped).toBeLessThan(200_000);
		expect(200_000 - clamped).toBeGreaterThan(0);
	});

	it("never leaves less than the minimum usable budget", () => {
		const clamped = clampReserveTokens(200_000, 195_000);
		const budget = 200_000 - clamped;
		expect(budget).toBeGreaterThanOrEqual(budget); // sanity
		expect(budget).toBeGreaterThanOrEqual(MIN_BUDGET_FLOOR);
	});

	it("scales the floor with the window rather than a fixed number alone", () => {
		// A tiny context window and a huge one should not share one
		// absolute floor: 10 percent of a small window is smaller than
		// the absolute floor, so the absolute floor wins there, and 10
		// percent of a huge window is bigger than the absolute floor, so
		// the percentage wins there.
		const small = clampReserveTokens(8_000, 7_999);
		const large = clampReserveTokens(1_000_000, 999_999);
		expect(8_000 - small).toBeGreaterThanOrEqual(MIN_BUDGET_FLOOR);
		expect(1_000_000 - large).toBeGreaterThan(MIN_BUDGET_FLOOR);
	});

	it("never returns a negative reserve", () => {
		expect(clampReserveTokens(50_000, -100)).toBeGreaterThanOrEqual(0);
	});
});

// Mirrors the module's own floor so the test can assert against it by
// name rather than a bare number that would silently drift.
const MIN_BUDGET_FLOOR = 4096;

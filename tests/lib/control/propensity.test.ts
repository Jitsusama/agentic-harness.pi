import { describe, expect, it, vi } from "vitest";
import { choseWithPropensity } from "../../../lib/control/index.ts";

describe("logging propensity alongside an exploratory choice", () => {
	it("takes the deterministic choice most of the time, at propensity 1 minus the rate", () => {
		const random = vi.fn().mockReturnValue(0.5); // above the 5% exploration cut
		const result = choseWithPropensity({
			deterministic: "best",
			alternatives: ["worse-a", "worse-b"],
			explorationRate: 0.05,
			random,
		});
		expect(result).toEqual({
			value: "best",
			propensity: 0.95,
			explored: false,
		});
	});

	it("explores an alternative when the draw lands inside the exploration rate", () => {
		const random = vi
			.fn()
			.mockReturnValueOnce(0.02) // inside the 5% cut: explore
			.mockReturnValueOnce(0); // pick the first alternative
		const result = choseWithPropensity({
			deterministic: "best",
			alternatives: ["worse-a", "worse-b"],
			explorationRate: 0.05,
			random,
		});
		expect(result.value).toBe("worse-a");
		expect(result.explored).toBe(true);
		// Propensity of landing on this specific alternative: explorationRate / count.
		expect(result.propensity).toBeCloseTo(0.025, 5);
	});

	it("is undefined, not 0 or 1, without exploration: a deterministic policy has no propensity to log", () => {
		// This is the constraint the wider plan already found: a purely
		// deterministic policy makes every past choice propensity 0 or 1,
		// which breaks IPS and doubly-robust estimation. Exploration is
		// the only thing that makes propensity worth logging at all.
		const result = choseWithPropensity({
			deterministic: "best",
			alternatives: ["worse-a"],
			explorationRate: 0,
			random: () => 0.5,
		});
		expect(result).toEqual({ value: "best", propensity: 1, explored: false });
	});

	it("has nothing to explore into when there are no alternatives, and takes the deterministic choice at propensity 1", () => {
		const result = choseWithPropensity({
			deterministic: "only-option",
			alternatives: [],
			explorationRate: 0.05,
			random: () => 0,
		});
		expect(result).toEqual({
			value: "only-option",
			propensity: 1,
			explored: false,
		});
	});
});

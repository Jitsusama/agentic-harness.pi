import { describe, expect, it } from "vitest";
import { cachePrices } from "../../../extensions/demote-workflow/prices.js";

const RATES = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };

describe("the cache prices a demotion is weighed at", () => {
	it("uses the model's own five-minute write price by default", () => {
		expect(cachePrices(RATES, "anthropic-messages", undefined)).toEqual({
			readPrice: 0.5,
			writePrice: 6.25,
		});
	});

	it("prices a write at twice input under one-hour retention on Anthropic", () => {
		// What pi bills a one-hour write at, and what the live probe showed.
		expect(cachePrices(RATES, "anthropic-messages", "long")).toEqual({
			readPrice: 0.5,
			writePrice: 10,
		});
	});

	it("ignores one-hour retention on a provider that does not offer it", () => {
		expect(cachePrices(RATES, "openai-responses", "long")).toEqual({
			readPrice: 0.5,
			writePrice: 6.25,
		});
	});

	it("declines to price a model with no cache read rate, rather than divide by it", () => {
		expect(
			cachePrices({ ...RATES, cacheRead: 0 }, "anthropic-messages", undefined),
		).toBeUndefined();
	});
});

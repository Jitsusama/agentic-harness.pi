import { describe, expect, it } from "vitest";
import { compactionPays } from "../../../lib/compaction/index.ts";

/** Opus-shaped prices per token under one-hour retention. */
const PRICES = { readPrice: 0.5, inputPrice: 5, writePrice: 10 };

describe("deciding whether to compact now", () => {
	it("never compacts below the floor, however long the session has run", () => {
		const decision = compactionPays({
			contextTokens: 200_000,
			retainedTokens: 120_000,
			turnsSinceCompaction: 10_000,
			floorTokens: 250_000,
			...PRICES,
		});
		expect(decision.fire).toBe(false);
	});

	it("holds off early in a session, when there are few turns left to earn the cost back", () => {
		// 500k of context, 380k of it droppable, but only 10 turns in: the
		// summariser reading 500k at full input price and the retained 120k
		// written fresh (3.7M) cost more than 10 turns of reading 380k
		// saves (1.9M).
		const decision = compactionPays({
			contextTokens: 500_000,
			retainedTokens: 120_000,
			turnsSinceCompaction: 10,
			floorTokens: 250_000,
			...PRICES,
		});
		expect(decision.fire).toBe(false);
		expect(decision.margin).toBeLessThan(1);
	});

	it("compacts once the reads saved over the turns to come outweigh what compacting costs", () => {
		const decision = compactionPays({
			contextTokens: 500_000,
			retainedTokens: 120_000,
			turnsSinceCompaction: 200,
			floorTokens: 250_000,
			...PRICES,
		});
		// saved 380k * 0.5 * 200 = 38M; cost 500k * 5 + 120k * 10 = 3.7M.
		expect(decision.fire).toBe(true);
		expect(decision.margin).toBeCloseTo(38_000_000 / 3_700_000, 5);
	});

	it("says what compacting costs and how many turns at this size earn it back", () => {
		// The margin at the moment it fires is always just past one,
		// because the test fires on the first turn it crosses, so the
		// margin says nothing then. What does: the summary costs 3.7M
		// price-tokens, and each later turn saves 380k * 0.5 = 190k.
		const decision = compactionPays({
			contextTokens: 500_000,
			retainedTokens: 120_000,
			turnsSinceCompaction: 200,
			floorTokens: 250_000,
			...PRICES,
		});
		expect(decision.cost).toBe(3_700_000);
		expect(decision.turnsToRepay).toBeCloseTo(3_700_000 / 190_000, 5);
	});

	it("never repays a compaction that drops nothing", () => {
		const decision = compactionPays({
			contextTokens: 300_000,
			retainedTokens: 320_000,
			turnsSinceCompaction: 5_000,
			floorTokens: 250_000,
			...PRICES,
		});
		expect(decision.turnsToRepay).toBe(Number.POSITIVE_INFINITY);
	});

	it("does not compact when nothing past the retained prompt would be dropped", () => {
		const decision = compactionPays({
			contextTokens: 300_000,
			retainedTokens: 320_000,
			turnsSinceCompaction: 5_000,
			floorTokens: 250_000,
			...PRICES,
		});
		expect(decision.fire).toBe(false);
	});
});

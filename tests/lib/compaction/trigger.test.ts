import { describe, expect, it } from "vitest";
import {
	compactionCost,
	compactionPays,
	droppableRent,
	idleCompactionPays,
} from "../../../lib/compaction/index.ts";

/** Opus 5.5 list prices per token under one-hour retention. */
const PRICES = { readPrice: 0.2e-6, writePrice: 8e-6, outputPrice: 20e-6 };

const COST_INPUT = {
	contextTokens: 280_000,
	summaryOutputTokens: 8_000,
	rewriteTokens: 90_000,
	refetchTurns: 3,
	refetchTurnCost: 0.07,
	prices: PRICES,
};

describe("what a compaction costs", () => {
	it("prices the summary read from cache, its output, the rewrite and the re-fetching", () => {
		const cost = compactionCost(COST_INPUT);
		// 280k read from cache and 8k written out by the summariser.
		expect(cost.summary).toBeCloseTo(280_000 * 0.2e-6 + 8_000 * 20e-6, 10);
		// The first turn after writes the 90k it keeps, which it would
		// otherwise have read from cache.
		expect(cost.rewrite).toBeCloseTo(90_000 * (8e-6 - 0.2e-6), 10);
		// Three turns spent fetching dropped context back.
		expect(cost.refetch).toBeCloseTo(0.21, 10);
		expect(cost.total).toBeCloseTo(
			cost.summary + cost.rewrite + cost.refetch,
			10,
		);
	});
});

describe("the rent droppable context pays", () => {
	it("is the read of everything a compaction would drop", () => {
		expect(droppableRent(280_000, 130_000, 0.2e-6)).toBeCloseTo(0.03, 10);
	});

	it("is nothing when the context is no larger than what a compaction keeps", () => {
		expect(droppableRent(120_000, 130_000, 0.2e-6)).toBe(0);
	});
});

describe("deciding whether to compact now", () => {
	const cost = compactionCost(COST_INPUT);

	it("holds off while the rent paid since the last compaction is less than compacting costs", () => {
		const decision = compactionPays({
			contextTokens: 280_000,
			rentPaid: cost.total * 0.99,
			cost,
			floorTokens: 0,
		});
		expect(decision.fire).toBe(false);
	});

	it("compacts once the rent paid reaches what compacting costs", () => {
		const decision = compactionPays({
			contextTokens: 280_000,
			rentPaid: cost.total,
			cost,
			floorTokens: 0,
		});
		expect(decision.fire).toBe(true);
	});

	it("never compacts a context at or below a floor someone set", () => {
		const decision = compactionPays({
			contextTokens: 200_000,
			rentPaid: cost.total * 10,
			cost,
			floorTokens: 200_000,
		});
		expect(decision.fire).toBe(false);
	});
});

describe("compacting before an idle session's cache expires", () => {
	const cost = compactionCost(COST_INPUT);

	it("pays when coming back would rewrite more than compacting now costs", () => {
		// Back after the hour, 280k is written at the write price; after a
		// compaction only the 130k kept is. 150k at $8/M is $1.20 against a
		// summary and re-fetching of about $0.43.
		expect(
			idleCompactionPays({
				contextTokens: 280_000,
				retainedTokens: 130_000,
				cost,
				prices: PRICES,
			}),
		).toBe(true);
	});

	it("does not pay when the context is little more than a compaction would keep", () => {
		expect(
			idleCompactionPays({
				contextTokens: 160_000,
				retainedTokens: 130_000,
				cost,
				prices: PRICES,
			}),
		).toBe(false);
	});
});

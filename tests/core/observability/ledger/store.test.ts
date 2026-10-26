import { describe, expect, it } from "vitest";
import {
	openTurnStore,
	type TurnRecord,
} from "../../../../lib/core/observability/ledger/index.ts";

const COST = {
	input: 0.00002,
	output: 0.0056,
	cacheRead: 0.0005,
	cacheWrite: 0.887,
	total: 0.893,
} as const;

/** The same cost shape with a different total, for grouping assertions. */
function costing(total: number) {
	return { ...COST, total };
}

function turn(overrides: Partial<TurnRecord> = {}): TurnRecord {
	return {
		entryId: "a1",
		sessionId: "s1",
		timestamp: "2026-09-21T17:55:00.000Z",
		kind: "assistant",
		model: "claude-opus-5",
		thinkingLevel: null,
		tokens: {
			input: 4,
			output: 224,
			cacheRead: 1000,
			cacheWrite: 141_937,
			total: 143_165,
		},
		cost: COST,
		cacheWrite1h: 141_937,
		droppedBefore: null,
		firstKeptEntryId: null,
		digest: "d1",
		...overrides,
	};
}

describe("TurnStore", () => {
	it("totals the cost of what it recorded", async () => {
		const store = await openTurnStore(":memory:");

		await store.recordTurns([
			turn({ digest: "d1" }),
			turn({ digest: "d2", cost: costing(1.107) }),
		]);

		const total = await store.total();
		expect(total.cost).toBeCloseTo(2.0, 5);
		expect(total.turns).toBe(2);
		await store.close();
	});

	it("bills a turn once however many times it is indexed", async () => {
		// Forking a session copies entries verbatim, and a re-index sees
		// the same log again. Either one double-bills unless the address
		// is the identity.
		const store = await openTurnStore(":memory:");

		const first = await store.recordTurns([turn({ digest: "d1" })]);
		const again = await store.recordTurns([
			turn({ digest: "d1", sessionId: "fork-of-s1" }),
		]);

		expect(first.inserted).toBe(1);
		expect(again.inserted).toBe(0);
		expect(again.duplicates).toBe(1);
		const total = await store.total();
		expect(total.cost).toBeCloseTo(0.893, 5);
		expect(total.turns).toBe(1);
		await store.close();
	});

	it("keeps an unmetered turn countable without pricing it at zero", async () => {
		const store = await openTurnStore(":memory:");

		await store.recordTurns([
			turn({ digest: "d1" }),
			turn({ digest: "d2", cost: null }),
		]);

		const total = await store.total();
		expect(total.cost).toBeCloseTo(0.893, 5);
		expect(total.turns).toBe(2);
		expect(total.unmetered).toBe(1);
		await store.close();
	});

	it("groups cost by a dimension, heaviest first", async () => {
		const store = await openTurnStore(":memory:");

		await store.recordTurns([
			turn({ digest: "d1", model: "claude-opus-5" }),
			turn({
				digest: "d2",
				model: "claude-sonnet-5",
				cost: costing(0.1),
			}),
			turn({ digest: "d3", model: "claude-opus-5" }),
		]);

		const slices = await store.costBy("model");
		expect(slices).toHaveLength(2);
		expect(slices[0].key).toBe("claude-opus-5");
		expect(slices[0].cost).toBeCloseTo(1.786, 5);
		expect(slices[0].turns).toBe(2);
		expect(slices[1].key).toBe("claude-sonnet-5");
		await store.close();
	});

	it("collapses turns that repeat inside one batch", async () => {
		// A single index pass reads many logs at once, and a forked entry
		// appears in every log descended from it. If the collapse only
		// happens between batches, one batch double-bills.
		const store = await openTurnStore(":memory:");

		const outcome = await store.recordTurns([
			turn({ digest: "d1", sessionId: "s1" }),
			turn({ digest: "d1", sessionId: "fork-of-s1" }),
			turn({ digest: "d2" }),
		]);

		expect(outcome.inserted).toBe(2);
		expect(outcome.duplicates).toBe(1);
		const total = await store.total();
		expect(total.turns).toBe(2);
		expect(total.cost).toBeCloseTo(1.786, 5);
		await store.close();
	});

	// 2,500 inserts ran past five seconds beside a full suite at a load
	// of 37; a hang still fails, later.
	it("records a batch larger than SQLite's parameter limit", {
		timeout: 30_000,
	}, async () => {
		// 40,000 turns arrive from one corpus pass. Binding them as one
		// statement exceeds the variable ceiling and throws.
		const store = await openTurnStore(":memory:");

		const many = Array.from({ length: 2500 }, (_, i) =>
			turn({ digest: `d${i}`, cost: costing(0.001) }),
		);
		const outcome = await store.recordTurns(many);

		expect(outcome.inserted).toBe(2500);
		expect((await store.total()).cost).toBeCloseTo(2.5, 5);
		await store.close();
	});

	it("reports one-hour cache writes apart from the rest", async () => {
		// Zero here against a large cache-write total is what proves the
		// long-retention setting is not actually in force.
		const store = await openTurnStore(":memory:");

		await store.recordTurns([
			turn({ digest: "d1", cacheWrite1h: 0 }),
			turn({ digest: "d2", cacheWrite1h: 141_937 }),
		]);

		const total = await store.total();
		expect(total.cacheWriteTokens).toBe(283_874);
		expect(total.cacheWrite1hTokens).toBe(141_937);
		await store.close();
	});
});

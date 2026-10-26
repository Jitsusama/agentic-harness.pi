import { describe, expect, it } from "vitest";
import {
	openTurnStore,
	type TurnRecord,
} from "../../../../lib/core/observability/ledger/index.ts";

function turn(overrides: Partial<TurnRecord> = {}): TurnRecord {
	return {
		entryId: "a1",
		sessionId: "s1",
		timestamp: "2026-09-21T17:50:00.000Z",
		kind: "assistant",
		model: "claude-opus-5",
		thinkingLevel: null,
		tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		cacheWrite1h: 0,
		droppedBefore: null,
		firstKeptEntryId: null,
		digest: overrides.entryId ?? "d1",
		...overrides,
	};
}

describe("payback replay against real compactions", () => {
	it("agrees with a compaction whose real numbers pass the payback test", async () => {
		const store = await openTurnStore(":memory:");
		await store.recordTurns([
			// A turn elsewhere establishes this model's real billed rate:
			// $2 for 1,000,000 cache-read tokens, $10 for 1,000,000 write.
			turn({
				entryId: "rate",
				digest: "rate",
				timestamp: "2026-09-21T10:00:00.000Z",
				tokens: {
					input: 0,
					output: 0,
					cacheRead: 1_000_000,
					cacheWrite: 1_000_000,
					total: 2_000_000,
				},
				cost: { input: 0, output: 0, cacheRead: 2, cacheWrite: 10, total: 12 },
			}),
			turn({
				entryId: "c1",
				digest: "c1",
				kind: "compaction",
				timestamp: "2026-09-21T17:55:00.000Z",
				droppedBefore: 400_000,
				firstKeptEntryId: "kept",
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 1, total: 1 },
			}),
			// The next turn's resident context is what was retained.
			turn({
				entryId: "kept",
				digest: "kept",
				timestamp: "2026-09-21T17:56:00.000Z",
				tokens: {
					input: 0,
					output: 0,
					cacheRead: 90_000,
					cacheWrite: 10_000,
					total: 100_000,
				},
			}),
			// 48 more turns in the same session after the compaction, so
			// there is real remaining length to save on.
			...Array.from({ length: 48 }, (_, i) =>
				turn({
					entryId: `t${i}`,
					digest: `t${i}`,
					timestamp: `2026-09-21T18:${String(i).padStart(2, "0")}:00.000Z`,
				}),
			),
		]);

		const result = await store.paybackReplay();
		expect(result.compactions).toBe(1);
		expect(result.evaluable).toBe(1);
		expect(result.agreed).toBe(1);
		expect(result.disagreed).toBe(0);
		await store.close();
	});

	it("disagrees with a compaction near the end of a session, with little left to save on", async () => {
		const store = await openTurnStore(":memory:");
		await store.recordTurns([
			turn({
				entryId: "rate",
				digest: "rate",
				timestamp: "2026-09-21T10:00:00.000Z",
				tokens: {
					input: 0,
					output: 0,
					cacheRead: 1_000_000,
					cacheWrite: 1_000_000,
					total: 2_000_000,
				},
				cost: { input: 0, output: 0, cacheRead: 2, cacheWrite: 10, total: 12 },
			}),
			turn({
				entryId: "c1",
				digest: "c1",
				kind: "compaction",
				timestamp: "2026-09-21T17:55:00.000Z",
				droppedBefore: 400_000,
				firstKeptEntryId: "kept",
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 1, total: 1 },
			}),
			turn({
				entryId: "kept",
				digest: "kept",
				timestamp: "2026-09-21T17:56:00.000Z",
				tokens: {
					input: 0,
					output: 0,
					cacheRead: 90_000,
					cacheWrite: 10_000,
					total: 100_000,
				},
			}),
			// Only one turn follows: little left to save on.
		]);

		const result = await store.paybackReplay();
		expect(result.compactions).toBe(1);
		expect(result.evaluable).toBe(1);
		expect(result.disagreed).toBe(1);
		await store.close();
	});

	it("leaves a compaction with no turn after it out of the evaluable count", async () => {
		const store = await openTurnStore(":memory:");
		await store.recordTurns([
			turn({
				entryId: "c1",
				digest: "c1",
				kind: "compaction",
				timestamp: "2026-09-21T17:55:00.000Z",
				droppedBefore: 400_000,
				firstKeptEntryId: "kept",
			}),
		]);

		const result = await store.paybackReplay();
		expect(result.compactions).toBe(1);
		expect(result.evaluable).toBe(0);
		await store.close();
	});

	it("leaves a session with no compactions out of the count entirely", async () => {
		const store = await openTurnStore(":memory:");
		await store.recordTurns([turn()]);

		const result = await store.paybackReplay();
		expect(result.compactions).toBe(0);
		await store.close();
	});
});

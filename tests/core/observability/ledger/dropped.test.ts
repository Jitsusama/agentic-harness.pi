import { describe, expect, it } from "vitest";
import {
	type DroppedCallRecord,
	openTurnStore,
	type ToolCallRecord,
} from "../../../../lib/core/observability/ledger/index.ts";

function call(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
	return {
		digest: "c1",
		sessionId: "s1",
		entryId: "a1",
		callId: "t1",
		timestamp: "2026-09-21T17:50:00.000Z",
		name: "read",
		argsDigest: "read-x",
		path: "/x",
		resultChars: 1000,
		resultDigest: "res-1",
		isError: false,
		verifierKind: null,
		...overrides,
	};
}

function dropped(
	overrides: Partial<DroppedCallRecord> = {},
): DroppedCallRecord {
	return {
		callDigest: "c1",
		sessionId: "s1",
		droppedAtEntryId: "comp1",
		droppedAtTimestamp: "2026-09-21T17:55:00.000Z",
		...overrides,
	};
}

describe("dropped calls and regret", () => {
	it("round-trips a dropped call", async () => {
		const store = await openTurnStore(":memory:");
		await store.recordCalls([call()]);
		await store.recordDropped([dropped()]);

		expect(await store.queryDropped()).toEqual([dropped()]);
		await store.close();
	});

	it("bills a drop once however many forked logs repeat it", async () => {
		const store = await openTurnStore(":memory:");
		await store.recordCalls([call()]);
		const first = await store.recordDropped([dropped()]);
		const again = await store.recordDropped([dropped()]);

		expect(first.inserted).toBe(1);
		expect(again.inserted).toBe(0);
		expect(await store.queryDropped()).toHaveLength(1);
		await store.close();
	});

	it("counts a dropped call asked again afterward as regret", async () => {
		const store = await openTurnStore(":memory:");
		await store.recordCalls([
			call({ digest: "c1", timestamp: "2026-09-21T17:50:00.000Z" }),
			call({
				digest: "c2",
				callId: "t2",
				timestamp: "2026-09-21T18:05:00.000Z",
				resultChars: 900,
			}),
		]);
		await store.recordDropped([
			dropped({
				callDigest: "c1",
				droppedAtTimestamp: "2026-09-21T17:55:00.000Z",
			}),
		]);

		const { inScope, reAsked: regret } = await store.regret();
		expect(inScope).toBe(1);
		expect(regret).toHaveLength(1);
		expect(regret[0]).toMatchObject({
			name: "read",
			argsDigest: "read-x",
			sessionId: "s1",
			resultChars: 900,
		});
		await store.close();
	});

	it("does not count a dropped call as regret unless it was asked again after the drop", async () => {
		const store = await openTurnStore(":memory:");
		await store.recordCalls([call()]);
		await store.recordDropped([dropped()]);

		expect(await store.regret()).toEqual({ inScope: 1, reAsked: [] });
		await store.close();
	});

	it("does not count a call before the drop as regret for it", async () => {
		// A repeat that happened before the drop is an ordinary repeat,
		// not a case of the context having to re-fetch what it lost.
		const store = await openTurnStore(":memory:");
		await store.recordCalls([
			call({ digest: "c1", timestamp: "2026-09-21T17:40:00.000Z" }),
			call({
				digest: "c2",
				callId: "t2",
				timestamp: "2026-09-21T17:45:00.000Z",
			}),
		]);
		await store.recordDropped([
			dropped({
				callDigest: "c1",
				droppedAtTimestamp: "2026-09-21T17:55:00.000Z",
			}),
		]);

		expect((await store.regret()).reAsked).toEqual([]);
		await store.close();
	});

	it("counts a dropped call once, at its first re-ask, however often it was asked after", async () => {
		// The real failure: every later repeat joined to the drop as its own
		// row, so one call re-issued 79,600 times read as 79,600 regrets.
		const store = await openTurnStore(":memory:");
		await store.recordCalls([
			call({ digest: "c1", timestamp: "2026-09-21T17:50:00.000Z" }),
			call({
				digest: "c2",
				callId: "t2",
				timestamp: "2026-09-21T18:00:00.000Z",
				resultChars: 700,
			}),
			call({
				digest: "c3",
				callId: "t3",
				timestamp: "2026-09-21T18:10:00.000Z",
				resultChars: 800,
			}),
		]);
		await store.recordDropped([dropped()]);

		const { reAsked } = await store.regret();
		expect(reAsked).toHaveLength(1);
		expect(reAsked[0]).toMatchObject({
			reAskedAtTimestamp: "2026-09-21T18:00:00.000Z",
			resultChars: 700,
		});
		await store.close();
	});

	it("scopes regret to the retrieval tools named, and counts only those as in scope", async () => {
		// Re-issuing an action is not re-asking for information a drop
		// discarded, so an action tool must not count either way.
		const store = await openTurnStore(":memory:");
		await store.recordCalls([
			call({ digest: "c1", timestamp: "2026-09-21T17:50:00.000Z" }),
			call({
				digest: "c2",
				callId: "t2",
				timestamp: "2026-09-21T18:00:00.000Z",
			}),
			call({
				digest: "a1",
				callId: "t3",
				name: "tdd_loop",
				argsDigest: "green",
				path: null,
				timestamp: "2026-09-21T17:51:00.000Z",
			}),
			call({
				digest: "a2",
				callId: "t4",
				name: "tdd_loop",
				argsDigest: "green",
				path: null,
				timestamp: "2026-09-21T18:01:00.000Z",
			}),
		]);
		await store.recordDropped([
			dropped({ callDigest: "c1" }),
			dropped({ callDigest: "a1" }),
		]);

		const report = await store.regret({ retrieval: ["read"] });
		expect(report.inScope).toBe(1);
		expect(report.reAsked.map((r) => r.name)).toEqual(["read"]);
		await store.close();
	});

	it("does not count a re-read of a file written to since the original read", async () => {
		// The file changed, so reading it again fetched something new rather
		// than something the context had already held.
		const store = await openTurnStore(":memory:");
		await store.recordCalls([
			call({ digest: "c1", timestamp: "2026-09-21T17:50:00.000Z" }),
			call({
				digest: "w1",
				callId: "t2",
				name: "edit",
				argsDigest: "edit-x",
				timestamp: "2026-09-21T17:58:00.000Z",
			}),
			call({
				digest: "c2",
				callId: "t3",
				timestamp: "2026-09-21T18:00:00.000Z",
			}),
		]);
		await store.recordDropped([dropped()]);

		const report = await store.regret({
			retrieval: ["read"],
			writers: ["edit"],
		});
		expect(report.inScope).toBe(1);
		expect(report.reAsked).toEqual([]);
		await store.close();
	});
});

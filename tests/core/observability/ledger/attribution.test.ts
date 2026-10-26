import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	openLedgerReader,
	openTurnStore,
	type SessionRecord,
	type TurnRecord,
} from "../../../../lib/core/observability/ledger/index.ts";

const COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	total: 1,
} as const;

function turn(overrides: Partial<TurnRecord> = {}): TurnRecord {
	return {
		entryId: "a1",
		sessionId: "s1",
		timestamp: "2026-09-21T17:55:00.000Z",
		kind: "assistant",
		model: "claude-opus-5",
		thinkingLevel: null,
		tokens: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		},
		cost: COST,
		cacheWrite1h: 0,
		droppedBefore: null,
		firstKeptEntryId: null,
		digest: "d1",
		...overrides,
	};
}

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
	return {
		sessionId: "s1",
		cwd: "/Users/j/src/github.com/Shopify/world",
		repo: "github.com/Shopify/world",
		quest: "QEST-1",
		firstSeen: "2026-09-21T17:00:00.000Z",
		lastSeen: "2026-09-21T18:00:00.000Z",
		...overrides,
	};
}

describe("TurnStore attribution", () => {
	it("groups cost by the repo a session was working in", async () => {
		const store = await openTurnStore(":memory:");
		await store.recordSession(session({ sessionId: "s1" }));
		await store.recordSession(
			session({ sessionId: "s2", repo: "world/system/gitstream" }),
		);
		await store.recordTurns([
			turn({ digest: "d1", sessionId: "s1" }),
			turn({ digest: "d2", sessionId: "s1" }),
			turn({ digest: "d3", sessionId: "s2" }),
		]);

		const slices = await store.costBy("repo");
		expect(slices[0].key).toBe("github.com/Shopify/world");
		expect(slices[0].cost).toBeCloseTo(2, 5);
		expect(slices[1].key).toBe("world/system/gitstream");
		await store.close();
	});

	it("groups cost by quest", async () => {
		const store = await openTurnStore(":memory:");
		await store.recordSession(session({ sessionId: "s1", quest: "QEST-A" }));
		await store.recordSession(session({ sessionId: "s2", quest: "QEST-B" }));
		await store.recordTurns([
			turn({ digest: "d1", sessionId: "s1" }),
			turn({ digest: "d2", sessionId: "s2" }),
			turn({ digest: "d3", sessionId: "s2" }),
		]);

		const slices = await store.costBy("quest");
		expect(slices[0].key).toBe("QEST-B");
		expect(slices[0].cost).toBeCloseTo(2, 5);
		await store.close();
	});

	it("keeps unattributed spend as its own slice", async () => {
		// Most sessions name no quest. An inner join would silently drop
		// them and every quest share would be computed against a total
		// that excluded the majority of the money.
		const store = await openTurnStore(":memory:");
		await store.recordSession(session({ sessionId: "s1", quest: "QEST-A" }));
		await store.recordSession(session({ sessionId: "s2", quest: null }));
		await store.recordTurns([
			turn({ digest: "d1", sessionId: "s1" }),
			turn({ digest: "d2", sessionId: "s2" }),
			turn({ digest: "d3", sessionId: "unknown-session" }),
		]);

		const slices = await store.costBy("quest");
		const unattributed = slices.find((s) => s.key === "");
		expect(unattributed?.cost).toBeCloseTo(2, 5);
		const sum = slices.reduce((n, s) => n + s.cost, 0);
		expect(sum).toBeCloseTo((await store.total()).cost, 5);
		await store.close();
	});

	it("takes a later statement about a session over an earlier one", async () => {
		// A re-index reads the same log again, and a session that moved
		// quest reports the newer one. The row is a current fact, not an
		// append-only history.
		const store = await openTurnStore(":memory:");
		await store.recordSession(session({ quest: "QEST-A" }));
		await store.recordSession(session({ quest: "QEST-B" }));
		await store.recordTurns([turn({ digest: "d1" })]);

		const slices = await store.costBy("quest");
		expect(slices).toHaveLength(1);
		expect(slices[0].key).toBe("QEST-B");
		await store.close();
	});
});

describe("TurnStore booking each turn where it sits", () => {
	/** Each slice's cost, by its key. */
	async function costs(
		store: Awaited<ReturnType<typeof openTurnStore>>,
		dimension: "quest" | "document",
	) {
		const slices = await store.costBy(dimension);
		return Object.fromEntries(slices.map((s) => [s.key, s.cost]));
	}

	it("books a turn to the quest in force at it, not the session's last", async () => {
		const store = await openTurnStore(":memory:");
		await store.recordSession(session({ quest: "QEST-B" }));
		await store.recordTurns([
			turn({ digest: "d1", quest: "QEST-A" }),
			turn({ digest: "d2", quest: "QEST-B" }),
			turn({ digest: "d3", quest: null }),
		]);

		expect(await costs(store, "quest")).toEqual({
			"QEST-A": 1,
			"QEST-B": 1,
			"": 1,
		});
		await store.close();
	});

	it("falls back to the session's quest for a turn the scan did not book", async () => {
		const store = await openTurnStore(":memory:");
		await store.recordSession(session({ quest: "QEST-B" }));
		await store.recordTurns([turn({ digest: "d1" })]);

		expect(await costs(store, "quest")).toEqual({ "QEST-B": 1 });
		await store.close();
	});

	it("books a turn to the document focused at it", async () => {
		const store = await openTurnStore(":memory:");
		await store.recordTurns([
			turn({ digest: "d1", quest: "QEST-A", document: "PLAN-1" }),
			turn({ digest: "d2", quest: "QEST-A", document: "PLAN-1" }),
			turn({ digest: "d3", quest: "QEST-A", document: null }),
		]);

		expect(await costs(store, "document")).toEqual({ "PLAN-1": 2, "": 1 });
		await store.close();
	});

	it("gives a turn indexed before booking its quest on the next scan", async () => {
		const store = await openTurnStore(":memory:");
		await store.recordSession(session({ quest: "QEST-B" }));
		await store.recordTurns([turn({ digest: "d1" })]);

		await store.recordTurns([
			turn({ digest: "d1", quest: "QEST-A", document: "PLAN-1" }),
		]);

		expect(await costs(store, "quest")).toEqual({ "QEST-A": 1 });
		expect(await costs(store, "document")).toEqual({ "PLAN-1": 1 });
		await store.close();
	});

	it("shows each turn's own booking in turn_facts", async () => {
		const path = join(mkdtempSync(join(tmpdir(), "ledger-")), "ledger.db");
		const store = await openTurnStore(path);
		await store.recordSession(session({ quest: "QEST-B" }));
		await store.recordTurns([
			turn({ digest: "d1", quest: "QEST-A", document: "PLAN-1" }),
			turn({ digest: "d2", quest: null, document: null }),
			turn({ digest: "d3" }),
		]);
		const reader = await openLedgerReader(path);

		const answer = await reader.query(
			"SELECT digest, quest, document FROM turn_facts ORDER BY digest",
		);

		expect(answer.rows).toEqual([
			{ digest: "d1", quest: "QEST-A", document: "PLAN-1" },
			{ digest: "d2", quest: null, document: null },
			{ digest: "d3", quest: "QEST-B", document: null },
		]);
		await Promise.all([reader.close(), store.close()]);
	});
});

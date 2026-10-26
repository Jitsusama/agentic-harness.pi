import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	openTurnStore,
	type SessionRecord,
	type TurnRecord,
} from "../../../../lib/core/observability/ledger/index.ts";
import { toOlderShape } from "./older-shape.ts";

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
			cacheWrite: 0,
			total: 1228,
		},
		cost: { input: 0, output: 0, cacheRead: 1, cacheWrite: 0, total: 1 },
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
		cwd: "/src/repo",
		repo: "github.com/o/repo",
		quest: "QEST-1",
		firstSeen: "2026-09-21T17:55:00.000Z",
		lastSeen: "2026-09-21T18:55:00.000Z",
		...overrides,
	};
}

describe("sessions", () => {
	it("lists every session the ledger holds, so another store can join to them", async () => {
		const store = await openTurnStore(":memory:");
		await store.recordSession(session());
		await store.recordSession(session({ sessionId: "s2", quest: null }));

		const sessions = await store.sessions();

		expect(sessions).toEqual([
			session(),
			session({ sessionId: "s2", quest: null }),
		]);
		await store.close();
	});
});

describe("thinking level", () => {
	it("groups spend by the thinking level each turn ran at, unknown kept visible", async () => {
		const store = await openTurnStore(":memory:");
		await store.recordTurns([
			turn({ digest: "d1", thinkingLevel: "high" }),
			turn({ digest: "d2", thinkingLevel: "high" }),
			turn({ digest: "d3", thinkingLevel: null }),
		]);

		const slices = await store.costBy("thinking");

		expect(slices).toEqual([
			{ key: "high", cost: 2, turns: 2 },
			{ key: "", cost: 1, turns: 1 },
		]);
		await store.close();
	});

	it("fills the level on a turn it already held, so a rescan backfills the column", async () => {
		const store = await openTurnStore(":memory:");
		await store.recordTurns([turn({ digest: "d1", thinkingLevel: null })]);

		const outcome = await store.recordTurns([
			turn({ digest: "d1", thinkingLevel: "medium" }),
		]);

		expect(outcome).toEqual({ inserted: 0, duplicates: 1 });
		expect(await store.costBy("thinking")).toEqual([
			{ key: "medium", cost: 1, turns: 1 },
		]);
		await store.close();
	});

	it("never overwrites a level it already knew", async () => {
		const store = await openTurnStore(":memory:");
		await store.recordTurns([turn({ digest: "d1", thinkingLevel: "high" })]);

		await store.recordTurns([turn({ digest: "d1", thinkingLevel: "low" })]);

		expect(await store.costBy("thinking")).toEqual([
			{ key: "high", cost: 1, turns: 1 },
		]);
		await store.close();
	});

	it("adds the column to a ledger written before it existed, keeping its turns", async () => {
		const path = join(mkdtempSync(join(tmpdir(), "ledger-")), "ledger.db");
		const store = await openTurnStore(path);
		await store.recordTurns([turn({ digest: "d1" })]);
		await store.close();
		await toOlderShape(path, "ALTER TABLE turns DROP COLUMN thinking_level");

		const reopened = await openTurnStore(path);

		expect((await reopened.total()).turns).toBe(1);
		expect(await reopened.costBy("thinking")).toEqual([
			{ key: "", cost: 1, turns: 1 },
		]);
		await reopened.close();
	});
});

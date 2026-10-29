import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	type CompactionFacts,
	LEDGER_QUERY_ROW_CAP,
	openLedgerReader,
	openTurnStore,
	type TurnFacts,
	type TurnRecord,
} from "../../../../lib/core/observability/ledger/index.ts";
import { toOlderShape } from "./older-shape.ts";

const FACTS: TurnFacts = {
	precededBy: "results",
	gapMs: 8000,
	newTokens: 1500,
	stopReason: "toolUse",
	thinkingChars: 400,
	textChars: 120,
	runId: "r1",
	runTurn: 1,
};

const COMPACTED: CompactionFacts = {
	written: "ahead",
	summariser: "conversation",
	summaryMs: 58_000,
	waitedMs: 0,
	summaryChars: 16_000,
	abortedRequest: true,
	resumed: true,
	sinceTypedMs: 1_080_000,
};

let sequence = 0;

/** An assistant turn at a minute past the hour, reading a warm cache. */
function turn(overrides: Partial<TurnRecord> = {}): TurnRecord {
	sequence += 1;
	// Padded, so ordering by digest is the order the turns were made in.
	const id = String(sequence).padStart(6, "0");
	return {
		entryId: `e${id}`,
		sessionId: "s1",
		timestamp: "2026-09-24T10:00:00.000Z",
		kind: "assistant",
		model: "claude-opus-5-5",
		thinkingLevel: "high",
		tokens: {
			input: 0,
			output: 300,
			cacheRead: 100_000,
			cacheWrite: 2000,
			total: 102_300,
		},
		cost: {
			input: 0,
			output: 0.0075,
			cacheRead: 0.02,
			cacheWrite: 0.016,
			total: 0.0435,
		},
		cacheWrite1h: 2000,
		droppedBefore: null,
		firstKeptEntryId: null,
		digest: `d${id}`,
		facts: FACTS,
		...overrides,
	};
}

/** A turn that wrote the whole context again, 100k tokens past what was new. */
function missed(facts: Partial<TurnFacts>, cacheRead = 0): TurnRecord {
	return turn({
		tokens: {
			input: 0,
			output: 300,
			cacheRead,
			cacheWrite: 103_500,
			total: 103_800 + cacheRead,
		},
		cost: {
			input: 0,
			output: 0.0075,
			cacheRead: cacheRead * 0.2e-6,
			cacheWrite: 0.828,
			total: 0.8355 + cacheRead * 0.2e-6,
		},
		facts: { ...FACTS, ...facts },
	});
}

function compaction(overrides: Partial<TurnRecord> = {}): TurnRecord {
	return turn({
		kind: "compaction",
		tokens: { input: 0, output: 4000, cacheRead: 0, cacheWrite: 0, total: 0 },
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 },
		droppedBefore: 240_000,
		facts: { ...FACTS, stopReason: null, newTokens: null, runTurn: 3 },
		compaction: COMPACTED,
		...overrides,
	});
}

async function ledger(turns: readonly TurnRecord[]) {
	const path = join(mkdtempSync(join(tmpdir(), "ledger-")), "ledger.db");
	const store = await openTurnStore(path);
	await store.recordTurns(turns);
	const reader = await openLedgerReader(path);
	return { path, store, reader };
}

describe("ledger views", () => {
	it("gives every turn its facts, joined to its session", async () => {
		const { store, reader } = await ledger([turn({ digest: "only" })]);
		await store.recordSession({
			sessionId: "s1",
			cwd: "/src/repo",
			repo: "github.com/o/repo",
			quest: "Q1",
			firstSeen: null,
			lastSeen: null,
		});

		const answer = await reader.query(
			"SELECT preceded_by, gap_ms, new_tokens, run_id, run_turn, context, repo FROM turn_facts",
		);

		expect(answer.rows).toEqual([
			{
				preceded_by: "results",
				gap_ms: 8000,
				new_tokens: 1500,
				run_id: "r1",
				run_turn: 1,
				context: 102_000,
				repo: "github.com/o/repo",
			},
		]);
		await Promise.all([reader.close(), store.close()]);
	});

	it("dates a turn by the machine's own day, not UTC's", async () => {
		// Half past nine on a local evening, which is the next day in UTC
		// anywhere west of Greenwich.
		const evening = new Date(2026, 9, 28, 21, 30).toISOString();
		const { store, reader } = await ledger([turn({ timestamp: evening })]);

		const answer = await reader.query("SELECT day FROM turn_facts");
		const slices = await store.costBy("day");

		expect(answer.rows).toEqual([{ day: "2026-10-28" }]);
		expect(slices.map((slice) => slice.key)).toEqual(["2026-10-28"]);
		await Promise.all([reader.close(), store.close()]);
	});

	it("attributes each miss to what came before it", async () => {
		const { store, reader } = await ledger([
			turn(),
			missed({ precededBy: "compaction" }),
			missed({ precededBy: "typed", gapMs: 2 * 3_600_000 }),
			missed({ precededBy: "tools", gapMs: 30_000 }),
			missed({ precededBy: "typed", gapMs: 30_000 }, 40_000),
			missed({ precededBy: "model" }),
			missed({ precededBy: "nothing" }),
			missed({ precededBy: "results" }, 40_000),
		]);

		const answer = await reader.query(
			"SELECT cause, excess_tokens FROM misses ORDER BY digest",
		);

		expect(answer.rows.map((row) => row.cause)).toEqual([
			"after compaction",
			"idle over an hour",
			"prompt changed",
			"after a typed message",
			"model change",
			"full miss, unexplained",
			"partial miss, unexplained",
		]);
		// Written past the estimate of what was new, less the slack.
		expect(answer.rows[0]?.excess_tokens).toBe(103_500 - 1500 - 2000);
		await Promise.all([reader.close(), store.close()]);
	});

	it("does not count an ordinary turn, or a first turn, as a miss", async () => {
		const { store, reader } = await ledger([
			turn(),
			missed({ precededBy: null, gapMs: null }),
		]);

		const answer = await reader.query("SELECT COUNT(*) AS misses FROM misses");

		expect(answer.rows).toEqual([{ misses: 0 }]);
		await Promise.all([reader.close(), store.close()]);
	});

	it("runs a cycle from one compaction to the next", async () => {
		const at = (minute: number) =>
			`2026-09-24T10:${String(minute).padStart(2, "0")}:00.000Z`;
		const { store, reader } = await ledger([
			turn({ timestamp: at(0) }),
			compaction({ timestamp: at(1) }),
			turn({ timestamp: at(2) }),
			turn({
				timestamp: at(3),
				tokens: {
					input: 0,
					output: 300,
					cacheRead: 150_000,
					cacheWrite: 2000,
					total: 152_300,
				},
			}),
			compaction({ timestamp: at(4) }),
			turn({ timestamp: at(5) }),
		]);

		const answer = await reader.query(
			"SELECT cycle, turns, context_start, context_end, closed FROM cycles ORDER BY cycle",
		);

		expect(answer.rows).toEqual([
			{
				cycle: 1,
				turns: 2,
				context_start: 102_000,
				context_end: 152_000,
				closed: 1,
			},
			{
				cycle: 2,
				turns: 1,
				context_start: 102_000,
				context_end: 102_000,
				closed: 0,
			},
		]);
		await Promise.all([reader.close(), store.close()]);
	});

	it("counts a side call in its cycle's side cost and not as a turn", async () => {
		const at = (minute: number) =>
			`2026-09-24T10:${String(minute).padStart(2, "0")}:00.000Z`;
		const side = (minute: number, total: number) =>
			turn({
				kind: "side",
				timestamp: at(minute),
				cost: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, total },
				facts: undefined,
			});
		const { store, reader } = await ledger([
			side(0, 0.5),
			compaction({ timestamp: at(1) }),
			turn({ timestamp: at(2) }),
			side(3, 0.01),
			side(4, 0.02),
		]);

		const answer = await reader.query(
			"SELECT cycle, turns, cost, side_cost FROM cycles ORDER BY cycle",
		);

		expect(answer.rows).toEqual([
			{ cycle: 1, turns: 1, cost: 0.0435, side_cost: 0.03 },
		]);
		await Promise.all([reader.close(), store.close()]);
	});

	it("sums a run once however many sessions forked it", async () => {
		const { store, reader } = await ledger([
			turn({ facts: { ...FACTS, runId: "r1", runTurn: 1 } }),
			turn({ sessionId: "fork", facts: { ...FACTS, runId: "r1", runTurn: 2 } }),
			turn({ facts: { ...FACTS, runId: "r2", runTurn: 1 } }),
		]);

		const answer = await reader.query(
			"SELECT run_id, turns FROM runs ORDER BY run_id",
		);

		expect(answer.rows).toEqual([
			{ run_id: "r1", turns: 2 },
			{ run_id: "r2", turns: 1 },
		]);
		await Promise.all([reader.close(), store.close()]);
	});

	it("says what surrounded each compaction and how long the run took to resume", async () => {
		const { store, reader } = await ledger([
			compaction({ timestamp: "2026-09-24T10:00:00.000Z" }),
			turn({ timestamp: "2026-09-24T10:00:11.000Z" }),
		]);

		const answer = await reader.query(
			"SELECT written, aborted_request, resumed, turns_into_run, resume_ms FROM compaction_moments",
		);

		expect(answer.rows).toEqual([
			{
				written: "ahead",
				aborted_request: 1,
				resumed: 1,
				turns_into_run: 3,
				resume_ms: 11_000,
			},
		]);
		await Promise.all([reader.close(), store.close()]);
	});
});

describe("recording facts", () => {
	it("fills in what a later scan learned about a turn it already holds", async () => {
		const unfinished = compaction({
			digest: "c",
			compaction: { ...COMPACTED, resumed: null },
		});
		const { store, reader } = await ledger([
			{ ...unfinished, facts: undefined },
		]);

		await store.recordTurns([unfinished]);
		await store.recordTurns([compaction({ digest: "c" })]);
		await store.recordTurns([
			compaction({ digest: "c", compaction: { ...COMPACTED, resumed: false } }),
		]);

		const answer = await reader.query(
			"SELECT f.run_id, t.resumed FROM turn_facts AS f JOIN turns AS t USING (digest)",
		);
		// Known once, then left alone: the same entry cannot have two.
		expect(answer.rows).toEqual([{ run_id: "r1", resumed: 1 }]);
		expect((await store.total()).turns).toBe(1);
		await Promise.all([reader.close(), store.close()]);
	});

	it("adds the fact columns to a ledger written before they existed", async () => {
		const path = join(mkdtempSync(join(tmpdir(), "ledger-")), "ledger.db");
		const store = await openTurnStore(path);
		await store.recordTurns([turn({ digest: "old" })]);
		await store.close();
		await toOlderShape(path, "ALTER TABLE turns DROP COLUMN run_id");

		const reopened = await openTurnStore(path);
		await reopened.recordTurns([turn({ digest: "old" })]);
		const reader = await openLedgerReader(path);

		const answer = await reader.query("SELECT run_id FROM turn_facts");
		expect(answer.rows).toEqual([{ run_id: "r1" }]);
		await Promise.all([reader.close(), reopened.close()]);
	});
});

describe("ledger reader", () => {
	it("refuses anything but one SELECT", async () => {
		const { store, reader } = await ledger([turn()]);

		await expect(reader.query("DELETE FROM turns")).rejects.toThrow(
			/one SELECT/,
		);
		await expect(reader.query("SELECT 1; DELETE FROM turns")).rejects.toThrow(
			/one statement/,
		);
		expect((await reader.query("SELECT ';' AS semicolon;")).rows).toEqual([
			{ semicolon: ";" },
		]);
		await Promise.all([reader.close(), store.close()]);
	});

	it("cannot change the ledger even through a statement that starts as a query", async () => {
		const { store, reader } = await ledger([turn()]);

		await expect(
			reader.query("WITH doomed AS (SELECT 1) DELETE FROM turns"),
		).rejects.toThrow();
		expect((await store.total()).turns).toBe(1);
		await Promise.all([reader.close(), store.close()]);
	});

	it("refuses an answer too large to show rather than cutting it", async () => {
		const { store, reader } = await ledger([]);
		const count = (n: number) =>
			`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < ${n}) SELECT x FROM n`;

		expect((await reader.query(count(LEDGER_QUERY_ROW_CAP))).rows).toHaveLength(
			LEDGER_QUERY_ROW_CAP,
		);
		await expect(reader.query(count(LEDGER_QUERY_ROW_CAP + 1))).rejects.toThrow(
			/Aggregate it, or add a LIMIT/,
		);
		await Promise.all([reader.close(), store.close()]);
	});

	it("keeps a trailing comment from swallowing the row bound", async () => {
		const { store, reader } = await ledger([turn()]);

		const answer = await reader.query(
			"SELECT COUNT(*) AS turns FROM turns -- how many",
		);

		expect(answer).toEqual({ columns: ["turns"], rows: [{ turns: 1 }] });
		await Promise.all([reader.close(), store.close()]);
	});
});

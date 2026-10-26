/**
 * The resource report: each turn's use recorded beside its session's
 * log, and booked to the quest the ledger booked that session's turns
 * to at the time.
 */

import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { indexSessionLogs } from "../../../extensions/spend-workflow/indexer.ts";
import {
	earliest,
	forgetLastReading,
	formatUse,
	type QuestUse,
	questChangesQuery,
	readSamples,
	recordTurn,
	type Sample,
	useByQuest,
} from "../../../extensions/spend-workflow/resources.ts";
import {
	openLedgerReader,
	openTurnStore,
} from "../../../lib/core/observability/index.ts";
import type { Counters } from "../../../lib/internal/resources.ts";

let scratch: string;

beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "resources-"));
	forgetLastReading();
});

afterEach(() => {
	rmSync(scratch, { recursive: true, force: true });
	forgetLastReading();
});

const reading = (cpu: number, children: number, rss = 500e6): Counters => ({
	cpuSelfMs: cpu,
	cpuChildrenMs: children,
	readBytes: 0,
	writeBytes: cpu * 1000,
	rssBytes: rss,
});

const sample = (
	at: string,
	cpu: number,
	children: number | null = 0,
	rss = 1,
): Sample => ({
	at,
	cpuSelfMs: cpu,
	cpuChildrenMs: children,
	readBytes: 0,
	writeBytes: 0,
	rssBytes: rss,
});

describe("a turn's end", () => {
	it("records what the process used since the last, in the session log's name", () => {
		const dir = join(scratch, "resources");
		const readings = [reading(1000, 0), reading(1500, 4000)];
		const deps = {
			dir,
			now: () => new Date("2026-10-23T05:00:00.000Z"),
			read: () => readings.shift() as Counters,
		};
		recordTurn("/logs/--home--/2026-10-23_s1.jsonl", deps);
		recordTurn("/logs/--home--/2026-10-23_s1.jsonl", deps);

		const lines = readFileSync(join(dir, "2026-10-23_s1.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(
			lines.map((l) => [l.cpuSelfMs, l.cpuChildrenMs, l.writeBytes]),
		).toEqual([
			[1000, 0, 1_000_000],
			[500, 4000, 500_000],
		]);
		expect(lines[0].at).toBe("2026-10-23T05:00:00.000Z");
	});

	it("carries on from the last reading in the process, as code a reload brings does", async () => {
		const dir = join(scratch, "resources");
		recordTurn("a.jsonl", { dir, read: () => reading(1000, 0) });
		// A reload loads this module again, as a copy of its own.
		vi.resetModules();
		const copy = await import(
			"../../../extensions/spend-workflow/resources.ts"
		);
		expect(copy.recordTurn).not.toBe(recordTurn);
		const second = copy.recordTurn("a.jsonl", {
			dir,
			read: () => reading(1200, 0),
		});
		expect(second.cpuSelfMs).toBe(200);
	});
});

describe("reading the figures back", () => {
	it("keeps every whole line and skips one a crash cut short", () => {
		const dir = join(scratch, "resources");
		mkdirSync(dir);
		writeFileSync(
			join(dir, "s1.jsonl"),
			`${JSON.stringify(sample("2026-10-23T05:00:00.000Z", 10))}\n{"at":"2026-10\n`,
		);
		writeFileSync(join(dir, "notes.txt"), "not a session");
		const samples = readSamples(dir);
		expect([...samples.keys()]).toEqual(["s1.jsonl"]);
		expect(samples.get("s1.jsonl")).toHaveLength(1);
		expect(readSamples(join(scratch, "missing")).size).toBe(0);
	});
});

describe("booking to quests", () => {
	const changes = [
		{ session: "s1", at: "2026-10-23T05:00:00.000Z", quest: "QEST-A" },
		{ session: "s1", at: "2026-10-23T06:00:00.000Z", quest: "QEST-B" },
		{ session: "s2", at: "2026-10-23T05:00:00.000Z", quest: null },
	];

	it("books each turn to the quest in force when it ended, heaviest CPU first", () => {
		const samples = new Map([
			[
				"s1",
				[
					sample("2026-10-23T04:59:00.000Z", 10, 0, 300),
					sample("2026-10-23T05:30:00.000Z", 20, 0, 900),
					sample("2026-10-23T06:00:00.000Z", 5, 500, 400),
				],
			],
			["s2", [sample("2026-10-23T05:10:00.000Z", 1, null)]],
		]);
		const uses = useByQuest(samples, changes);
		const row = (u: QuestUse) => [
			u.quest,
			u.turns,
			u.cpuSelfMs,
			u.cpuChildrenMs,
			u.peakRssBytes,
		];
		expect(uses.map(row)).toEqual([
			["QEST-B", 1, 5, 500, 400],
			["QEST-A", 2, 30, 0, 900],
			[null, 1, 1, 0, 1],
		]);
		expect(uses[2]?.partial).toBe(true);
	});

	it("reads the moments a session's quest changed from the ledger itself", async () => {
		const sessions = join(scratch, "sessions", "proj");
		mkdirSync(sessions, { recursive: true });
		// Each entry names its parent, as pi writes them: the ledger books a
		// turn to the quest in force on its own branch of the log.
		const turn = (id: string, timestamp: string, parentId: string | null) =>
			JSON.stringify({
				id,
				parentId,
				type: "message",
				timestamp,
				message: {
					role: "assistant",
					model: "m",
					usage: { input: 1, output: 1, cost: { total: 0.1 } },
					content: [],
				},
			});
		const quest = (id: string) =>
			JSON.stringify({
				id: `q-${id}`,
				parentId: null,
				type: "custom",
				customType: "quest-workflow",
				data: { questId: id },
			});
		writeFileSync(
			join(sessions, "it's.jsonl"),
			`${[quest("QEST-A"), turn("a1", "2026-10-23T05:00:00.000Z", "q-QEST-A"), turn("a2", "2026-10-23T05:01:00.000Z", "a1")].join("\n")}\n`,
		);
		writeFileSync(
			join(sessions, "s2.jsonl"),
			`${turn("b1", "2026-10-23T05:02:00.000Z", null)}\n`,
		);
		const ledger = join(scratch, "ledger.db");
		const store = await openTurnStore(ledger);
		await indexSessionLogs(
			store,
			join(scratch, "marks.json"),
			join(scratch, "sessions"),
		);
		const reader = await openLedgerReader(ledger);
		try {
			const answer = await reader.query(
				questChangesQuery(["it's.jsonl", "s2.jsonl"]),
			);
			expect(
				answer.rows.map((r) => [r.session_id, r.timestamp, r.quest]),
			).toEqual([
				["it's.jsonl", "2026-10-23T05:00:00.000Z", "QEST-A"],
				["s2.jsonl", "2026-10-23T05:02:00.000Z", null],
			]);
		} finally {
			await reader.close();
			await store.close();
		}
	});
});

describe("the report", () => {
	it("says the totals, then each quest, and what it cannot see", () => {
		const samples = new Map([
			["s1", [sample("2026-10-23T05:30:00.000Z", 600_000, 7_200_000, 900e6)]],
		]);
		const uses = useByQuest(samples, [
			{ session: "s1", at: "2026-10-23T05:00:00.000Z", quest: "QEST-A" },
		]);
		const text = formatUse(uses, earliest(samples), 12);
		expect(text).toContain(
			"Since 2026-10-23, sessions used 2.2 CPU hours: 10 CPU minutes in pi itself and 2.0 CPU hours in the commands",
		);
		expect(text).toContain(
			"- QEST-A: 2.2 CPU hours (pi 10 minutes, what it ran 2.0 hours)",
		);
		expect(text).toContain("pi held up to 900 MB, over 1 turn");
		expect(text).toContain("nix-daemon");
	});

	it("says when there is nothing yet, rather than reading as idle", () => {
		expect(formatUse([], undefined, 12)).toMatch(/No resource figures yet/);
	});
});

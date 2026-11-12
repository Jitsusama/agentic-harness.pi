import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	openLedgerReader,
	openTurnStore,
	type TurnRecord,
} from "../../lib/core/observability/ledger/index.ts";
import {
	formatVoidCost,
	VOID_QUEST,
	voidCost,
} from "../../scripts/void-cost.ts";

/** 06:00 in Toronto on 12 November 2026. */
const NOW = Date.parse("2026-11-12T11:00:00.000Z");
const ZONE = "America/Toronto";

let sequence = 0;

/** A turn at `iso`, costing `cost`, booked to `quest`. */
function turn(iso: string, cost: number, quest = VOID_QUEST): TurnRecord {
	sequence += 1;
	const id = String(sequence).padStart(6, "0");
	return {
		entryId: `e${id}`,
		sessionId: "2026-11-12T06-29-25-996Z_void.jsonl",
		timestamp: iso,
		kind: "assistant",
		model: "claude-opus-5-5",
		thinkingLevel: "high",
		tokens: { input: 0, output: 100, cacheRead: 0, cacheWrite: 0, total: 100 },
		cost: { input: 0, output: cost, cacheRead: 0, cacheWrite: 0, total: cost },
		cacheWrite1h: 0,
		droppedBefore: null,
		firstKeptEntryId: null,
		digest: `d${id}`,
		quest,
	};
}

async function reportOf(
	turns: readonly TurnRecord[],
	days: Readonly<Record<string, string>>,
) {
	const path = join(mkdtempSync(join(tmpdir(), "void-cost-")), "ledger.db");
	const store = await openTurnStore(path);
	await store.recordTurns(turns);
	await store.close();
	const reader = await openLedgerReader(path);
	try {
		return await voidCost(
			(date) => days[date],
			async (sql) => (await reader.query(sql)).rows,
			NOW,
			ZONE,
		);
	} finally {
		await reader.close();
	}
}

describe("what each line the void routed cost", () => {
	it("books each turn to the line it followed within minutes", async () => {
		const report = await reportOf(
			[
				turn("2026-11-12T06:30:05.000Z", 0.28),
				turn("2026-11-12T06:30:20.000Z", 0.02),
				turn("2026-11-12T08:15:10.000Z", 0.03),
			],
			{
				"2026-11-12": [
					"- 01:30 keep this thought → kept",
					"- 03:15 deploy v3 needs a look → Deploy v3 [ab12cd34]",
				].join("\n"),
			},
		);
		expect(
			report.lines.map((line) => [line.at, line.went, line.turns, line.cost]),
			"each line's turns and cost",
		).toEqual([
			["01:30", "kept", 2, 0.3],
			["03:15", "Deploy v3 [ab12cd34]", 1, 0.03],
		]);
	});

	it("keeps turns far from any line apart, as the void's own upkeep", async () => {
		const report = await reportOf(
			[
				turn("2026-11-12T06:25:00.000Z", 0.28),
				turn("2026-11-12T06:30:05.000Z", 0.02),
				turn("2026-11-12T09:00:00.000Z", 0.3),
				turn("2026-11-12T09:00:00.000Z", 5, "QEST-20261025-QCXZEB"),
			],
			{ "2026-11-12": "- 01:30 keep this → kept" },
		);
		expect(
			[report.lines.at(0)?.cost, report.upkeep],
			"the line, then its start and a cold wake",
		).toEqual([0.02, 0.58]);
	});

	it("reads only the last day's lines, across both day files", async () => {
		const report = await reportOf([], {
			"2026-11-11": [
				"- 05:59 too early → kept",
				"- 22:10 late last night → for you: renew the passport",
			].join("\n"),
			"2026-11-12": "- 00:05 just after midnight → WCJQSG [ff00ee11] · undone",
		});
		expect(
			report.lines.map((line) => [line.day, line.at, line.went]),
			"the two lines in the window",
		).toEqual([
			["2026-11-11", "22:10", "for you: renew the passport"],
			["2026-11-12", "00:05", "WCJQSG [ff00ee11] · undone"],
		]);
	});

	it("says the day's total, each line's cost and where it went, never his words", () => {
		const text = formatVoidCost({
			lines: [
				{ day: "2026-11-12", at: "01:30", went: "kept", turns: 2, cost: 0.3 },
				{
					day: "2026-11-12",
					at: "03:15",
					went: "Deploy v3 [ab12cd34]",
					turns: 1,
					cost: 0.03,
				},
			],
			upkeep: 0.58,
		});
		expect(text).toContain("## The Void");
		expect(text).toContain("2 lines");
		expect(text).toContain("$0.33");
		expect(text).toContain("$0.58");
		expect(text).toContain(
			"| 2026-11-12 03:15 | Deploy v3 [ab12cd34] | 1 | $0.03 |",
		);
		expect(text).not.toContain("deploy v3 needs a look");
	});

	it("says so when the void took no line", () => {
		expect(formatVoidCost({ lines: [], upkeep: 0 })).toContain(
			"The void took no line in the last day.",
		);
	});
});

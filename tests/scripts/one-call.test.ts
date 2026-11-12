import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	openLedgerReader,
	openTurnStore,
	type ToolCallRecord,
	type TurnRecord,
} from "../../lib/core/observability/ledger/index.ts";
import { formatOneCall, oneCallTurns } from "../../scripts/one-call.ts";

const NOW = Date.parse("2026-11-12T11:00:00.000Z");
const HOUR_MS = 3_600_000;

let sequence = 0;

/** An assistant turn `hoursAgo` before the measure, with these tool calls. */
function step(
	sessionId: string,
	hoursAgo: number,
	tools: readonly string[],
): { turn: TurnRecord; calls: ToolCallRecord[] } {
	sequence += 1;
	const id = String(sequence).padStart(6, "0");
	const timestamp = new Date(NOW - hoursAgo * HOUR_MS).toISOString();
	const turn: TurnRecord = {
		entryId: `e${id}`,
		sessionId,
		timestamp,
		kind: "assistant",
		model: "claude-opus-5-5",
		thinkingLevel: "high",
		tokens: {
			input: 0,
			output: 300,
			cacheRead: 1000,
			cacheWrite: 0,
			total: 1300,
		},
		cost: {
			input: 0,
			output: 0.01,
			cacheRead: 0.01,
			cacheWrite: 0,
			total: 0.02,
		},
		cacheWrite1h: 0,
		droppedBefore: null,
		firstKeptEntryId: null,
		digest: `d${id}`,
	};
	const calls = tools.map((name, index) => ({
		digest: `c${id}-${index}`,
		sessionId,
		entryId: `e${id}`,
		callId: `t${id}-${index}`,
		timestamp,
		name,
		argsDigest: `a${id}-${index}`,
		path: null,
		resultChars: 10,
		resultDigest: `r${id}-${index}`,
		isError: false,
		verifierKind: null,
	}));
	return { turn, calls };
}

/** A ledger on disk holding these steps, read as the measure reads it. */
async function ledgerOf(
	steps: readonly { turn: TurnRecord; calls: ToolCallRecord[] }[],
): Promise<string> {
	const path = join(mkdtempSync(join(tmpdir(), "one-call-")), "ledger.db");
	const store = await openTurnStore(path);
	await store.recordTurns(steps.map((one) => one.turn));
	await store.recordCalls(steps.flatMap((one) => one.calls));
	await store.close();
	return path;
}

async function reportOf(
	steps: readonly { turn: TurnRecord; calls: ToolCallRecord[] }[],
) {
	const reader = await openLedgerReader(await ledgerOf(steps));
	try {
		return await oneCallTurns(
			async (sql) => (await reader.query(sql)).rows,
			NOW,
		);
	} finally {
		await reader.close();
	}
}

describe("turns doing one thing", () => {
	it("counts each day's turns by how many tool calls they made", async () => {
		const report = await reportOf([
			step("s1", 1, ["bash"]),
			step("s1", 2, ["read", "read"]),
			step("s1", 3, []),
			step("s1", 4, ["edit"]),
			step("s2", 30, ["bash"]),
		]);
		expect(report.days.slice(0, 2)).toEqual([
			{ ending: "2026-11-12", turns: 4, none: 1, one: 2, several: 1 },
			{ ending: "2026-11-11", turns: 1, none: 0, one: 1, several: 0 },
		]);
	});

	it("leaves out turns older than a week and compactions", async () => {
		const old = step("s1", 24 * 8, ["bash"]);
		const compaction = step("s1", 1, []);
		const report = await reportOf([
			old,
			{ ...compaction, turn: { ...compaction.turn, kind: "compaction" } },
			step("s1", 2, ["bash"]),
		]);
		expect(report.days.reduce((sum, day) => sum + day.turns, 0)).toBe(1);
	});

	it("names each tool's one-call turns and how many came right after another of its own", async () => {
		const report = await reportOf([
			step("s1", 5, ["bash"]),
			step("s1", 4, ["bash"]),
			step("s1", 3, ["bash"]),
			step("s1", 2, ["read"]),
			step("s2", 4.5, ["bash"]),
			step("s1", 30, ["read"]),
		]);
		expect(report.tools).toEqual([
			{ tool: "bash", turns: 4, afterItself: 2 },
			{ tool: "read", turns: 1, afterItself: 0 },
		]);
	});

	it("says the share in words and a row a day", async () => {
		const text = formatOneCall({
			days: [
				{ ending: "2026-11-12", turns: 200, none: 20, one: 158, several: 22 },
				{ ending: "2026-11-11", turns: 100, none: 10, one: 80, several: 10 },
			],
			tools: [{ tool: "bash", turns: 100, afterItself: 65 }],
		});
		expect(text).toContain("## Turns Doing One Thing");
		expect(text).toContain("79 of 100 turns made exactly one tool call");
		expect(text).toContain("| 2026-11-11 | 100 | 80 | 10 | 10 |");
		expect(text).toContain("| bash | 100 | 65 |");
	});
});

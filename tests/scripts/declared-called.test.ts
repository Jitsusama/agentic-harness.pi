import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { StandingPrompt } from "../../extensions/spend-workflow/standing.ts";
import {
	openLedgerReader,
	openTurnStore,
	type ToolCallRecord,
	type TurnRecord,
} from "../../lib/core/observability/ledger/index.ts";
import {
	declaredCalled,
	formatDeclaredCalled,
} from "../../scripts/declared-called.ts";

const NOW = Date.parse("2026-11-12T11:00:00.000Z");
const HOUR_MS = 3_600_000;

let sequence = 0;

/**
 * An assistant turn in session `uuid` `hoursAgo` before the measure,
 * reading a million tokens from the cache for $0.50, with these calls.
 */
function step(
	uuid: string,
	hoursAgo: number,
	tools: readonly string[],
): { turn: TurnRecord; calls: ToolCallRecord[] } {
	sequence += 1;
	const id = String(sequence).padStart(6, "0");
	const sessionId = `2026-11-12T00-00-00-000Z_${uuid}.jsonl`;
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
			output: 0,
			cacheRead: 1_000_000,
			cacheWrite: 0,
			total: 1_000_000,
		},
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0.5,
			cacheWrite: 0,
			total: 0.5,
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

/** A session that started declaring tools of these sizes, in characters. */
function started(
	session: string,
	byTool: Readonly<Record<string, number>>,
): StandingPrompt {
	const declarations = Object.values(byTool).reduce((a, b) => a + b, 0);
	return {
		session,
		repo: "r",
		tools: Object.keys(byTool).length,
		pieces: { declarations },
		byTool,
		redeclared: 0,
	};
}

async function reportOf(
	prompts: readonly StandingPrompt[],
	steps: readonly { turn: TurnRecord; calls: ToolCallRecord[] }[],
) {
	const path = join(mkdtempSync(join(tmpdir(), "declared-")), "ledger.db");
	const store = await openTurnStore(path);
	await store.recordTurns(steps.map((one) => one.turn));
	await store.recordCalls(steps.flatMap((one) => one.calls));
	await store.close();
	const reader = await openLedgerReader(path);
	try {
		return await declaredCalled(
			prompts,
			async (sql) => (await reader.query(sql)).rows,
			NOW,
		);
	} finally {
		await reader.close();
	}
}

describe("tools declared against tools called", () => {
	it("counts where each tool was declared and where it was called", async () => {
		const report = await reportOf(
			[
				started("a", { bash: 400, slack: 4_000 }),
				started("b", { bash: 400, slack: 4_000 }),
			],
			[
				step("a", 1, ["bash", "bash"]),
				step("a", 2, ["slack"]),
				step("b", 1, ["bash"]),
			],
		);
		expect(
			report.tools.map(({ tool, sessions, calledIn, calls }) => ({
				tool,
				sessions,
				calledIn,
				calls,
			})),
			"each tool's sessions and calls",
		).toEqual([
			{ tool: "slack", sessions: 2, calledIn: 1, calls: 1 },
			{ tool: "bash", sessions: 2, calledIn: 2, calls: 3 },
		]);
	});

	it("prices a declaration a session never called at that session's reads", async () => {
		// b read slack's 4,000 characters, about 1,000 tokens, on each of
		// its two turns, at $0.50 a million.
		const report = await reportOf(
			[started("a", { slack: 4_000 }), started("b", { slack: 4_000 })],
			[step("a", 1, ["slack"]), step("b", 1, []), step("b", 2, [])],
		);
		expect(report.tools.at(0)?.unusedCost, "slack unread in b").toBeCloseTo(
			0.001,
			6,
		);
		expect(report.unusedCost, "the day's whole unused cost").toBeCloseTo(
			0.001,
			6,
		);
	});

	it("leaves out sessions with no turn in the last day", async () => {
		const report = await reportOf(
			[started("a", { bash: 400 }), started("old", { bash: 400 })],
			[step("a", 1, ["bash"]), step("old", 30, ["bash"])],
		);
		expect(
			[report.sessions, report.tools.at(0)?.sessions],
			"only a's day",
		).toEqual([1, 1]);
	});

	it("says the median declarations and a row a tool, dearest unused first", () => {
		const text = formatDeclaredCalled({
			sessions: 120,
			medianDeclared: 151_000,
			unusedCost: 412.5,
			tools: [
				{
					tool: "slack",
					sessions: 120,
					chars: 9_800,
					calledIn: 3,
					calls: 11,
					unusedCost: 96.25,
				},
			],
		});
		expect(text).toContain("## Declared, Called");
		expect(text).toContain("120 sessions");
		expect(text).toContain("151k characters");
		expect(text).toContain("$412.50");
		expect(text).toContain("| slack | 120 | 9,800 | 3 | 11 | $96.25 |");
	});

	it("says so when no session worked in the last day", () => {
		expect(
			formatDeclaredCalled({
				sessions: 0,
				medianDeclared: 0,
				unusedCost: 0,
				tools: [],
			}),
		).toContain("No session");
	});
});

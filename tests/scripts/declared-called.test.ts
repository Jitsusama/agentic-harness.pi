import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	type DeclarationRecord,
	type InnerCallRecord,
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

/**
 * A system message in session `uuid` `hoursAgo` before the measure
 * (by default before the day began), declaring tools of these sizes in
 * characters, a size of 0 taking the tool away.
 */
function declared(
	uuid: string,
	byTool: Readonly<Record<string, number>>,
	hoursAgo = 30,
): DeclarationRecord[] {
	sequence += 1;
	return Object.entries(byTool).map(([tool, chars]) => ({
		sessionId: `2026-11-12T00-00-00-000Z_${uuid}.jsonl`,
		entryId: `s${sequence}`,
		timestamp: new Date(NOW - hoursAgo * HOUR_MS).toISOString(),
		tool,
		change: chars > 0 ? "added" : "removed",
		chars,
	}));
}

/** A session that started declaring tools of these sizes, in characters. */
function started(
	uuid: string,
	byTool: Readonly<Record<string, number>>,
): DeclarationRecord[] {
	return declared(uuid, byTool);
}

/** The calls a step's first call made to other tools, as the scan keeps them. */
function through(
	one: { turn: TurnRecord; calls: ToolCallRecord[] },
	via: InnerCallRecord["via"],
	names: readonly string[],
): { turn: TurnRecord; calls: ToolCallRecord[]; inner: InnerCallRecord[] } {
	const outer = one.calls.at(0);
	if (!outer) throw new Error("a step with no call made none through it");
	return {
		...one,
		inner: names.map((name, index) => ({
			digest: `${outer.digest}/${index}`,
			sessionId: outer.sessionId,
			entryId: outer.entryId,
			outerCallId: outer.callId,
			timestamp: outer.timestamp,
			name,
			via,
			status: "ok",
			durationMs: null,
		})),
	};
}

async function reportOf(
	held: readonly DeclarationRecord[][],
	steps: readonly {
		turn: TurnRecord;
		calls: ToolCallRecord[];
		inner?: InnerCallRecord[];
	}[],
) {
	const path = join(mkdtempSync(join(tmpdir(), "declared-")), "ledger.db");
	const store = await openTurnStore(path);
	await store.recordTurns(steps.map((one) => one.turn));
	await store.recordCalls(steps.flatMap((one) => one.calls));
	await store.recordInnerCalls(steps.flatMap((one) => one.inner ?? []));
	await store.recordDeclarations(held.flat());
	await store.close();
	const reader = await openLedgerReader(path);
	try {
		return await declaredCalled(
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

	// A script's own calls aren't in the ledger (85PKB2 on #1395), so a
	// session that ran one may have called any tool through it.
	it("never prices a tool a session may have called through a script", async () => {
		const report = await reportOf(
			[
				started("a", { codemode: 400, slack: 4_000 }),
				started("b", { slack: 4_000 }),
			],
			[step("a", 1, ["codemode"]), step("b", 1, [])],
		);
		const slack = report.tools.find((tool) => tool.tool === "slack");
		expect(
			[slack?.scripted, slack?.unusedCost],
			"slack maybe in a's script, unread in b",
		).toEqual([1, 0.0005]);
	});

	it("prices a tool only for the turns a session held it", async () => {
		// a took slack away between its two turns, then b's and its own
		// turn came after slack came back at twice the size.
		const report = await reportOf(
			[
				started("a", { slack: 4_000 }),
				declared("a", { slack: 0 }, 1.5),
				declared("a", { slack: 8_000 }, 0.75),
			],
			[step("a", 2, []), step("a", 1, []), step("a", 0.5, [])],
		);
		const slack = report.tools.find(({ tool }) => tool === "slack");
		expect(
			[
				slack?.chars,
				report.medianDeclared,
				Number(slack?.unusedCost.toFixed(6)),
			],
			"held at 8,000 last; 12,000 over 3 turns; 1,000 then 2,000 tokens",
		).toEqual([8_000, 4_000, 0.0015]);
	});

	it("counts the tools a script called, and prices those it didn't", async () => {
		const report = await reportOf(
			[started("a", { codemode: 400, read: 400, slack: 4_000 })],
			[through(step("a", 1, ["codemode"]), "codemode", ["read", "read"])],
		);
		const row = (name: string) =>
			report.tools
				.filter(({ tool }) => tool === name)
				.map(({ calledIn, calls, scripted, unusedCost }) => [
					calledIn,
					calls,
					scripted,
					unusedCost,
				]);
		expect(
			[row("read"), row("slack")],
			"read called twice in the script, slack unread and priced",
		).toEqual([[[1, 2, 0, 0]], [[0, 0, 0, 0.0005]]]);
	});

	it("counts a gateway call once, from a script or not", async () => {
		const report = await reportOf(
			[
				started("a", { codemode: 400, tool_gateway_run_tool: 400 }),
				started("b", { tool_gateway_run_tool: 400 }),
			],
			[
				through(step("a", 1, ["codemode"]), "tool_gateway_run_tool", [
					"slack_search",
				]),
				through(
					step("b", 1, ["tool_gateway_run_tool"]),
					"tool_gateway_run_tool",
					["incident_list"],
				),
			],
		);
		const gateway = report.tools.find(
			({ tool }) => tool === "tool_gateway_run_tool",
		);
		expect(
			[gateway?.sessions, gateway?.calledIn, gateway?.calls],
			"called in both, once each",
		).toEqual([2, 2, 2]);
	});

	it("takes the middle of two sizes as their mean", async () => {
		const report = await reportOf(
			[started("a", { bash: 400 }), started("b", { bash: 600 })],
			[step("a", 1, ["bash"]), step("b", 1, ["bash"])],
		);
		expect(
			[report.medianDeclared, report.tools.at(0)?.chars],
			"the median of 400 and 600",
		).toEqual([500, 500]);
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
					scripted: 40,
					unusedCost: 96.25,
				},
			],
		});
		expect(text).toContain("## Declared, Called");
		expect(text).toContain("120 sessions");
		expect(text).toContain("151k characters");
		expect(text).toContain("at least $412.50");
		expect(text).toContain("| slack | 120 | 9,800 | 3 | 11 | 40 | $96.25 |");
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

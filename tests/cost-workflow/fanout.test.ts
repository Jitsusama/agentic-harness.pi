import type {
	RunRecord,
	SessionRecord,
} from "@jitsusama/agentic-harness.core/observability";
import { describe, expect, it } from "vitest";
import {
	fanOutBy,
	fanOutView,
	summarizeFanOut,
} from "../../extensions/cost-workflow/fanout.ts";
import { formatFanOut } from "../../extensions/cost-workflow/report.ts";

const DAY = Date.UTC(2026, 8, 22);

function run(
	over: Omit<Partial<RunRecord>, "cost"> & { cost: number | null },
): RunRecord {
	const { cost, ...rest } = over;
	return {
		runId: "r",
		subagentId: "s",
		kind: "fleet",
		model: "anthropic/claude-opus-5",
		persona: "p",
		verifyOutcome: "none",
		retriesToValid: 0,
		warningCount: 0,
		exitCode: 0,
		tokens: null,
		cost:
			cost === null
				? null
				: { input: 0, output: 0, cacheRead: cost, cacheWrite: 0, total: cost },
		startedAt: DAY,
		thinkingLevel: null,
		subagentSessionIds: null,
		...rest,
	};
}

describe("summarizeFanOut", () => {
	it("totals the run store by kind and keeps runs with no usage out of the price", () => {
		const summary = summarizeFanOut([
			run({ kind: "council", cost: 30 }),
			run({ kind: "council", cost: 10 }),
			run({ kind: "fleet", cost: 5 }),
			run({ kind: "fleet", cost: null }),
		]);

		expect(summary.cost).toBe(45);
		expect(summary.runs).toBe(4);
		expect(summary.unmetered).toBe(1);
		expect(summary.byKind).toEqual([
			{ key: "council", cost: 40, runs: 2 },
			{ key: "fleet", cost: 5, runs: 2 },
		]);
	});

	it("names when the earliest run started", () => {
		const summary = summarizeFanOut([
			run({ cost: 3, sessionId: "01a0" }),
			run({ cost: 7, sessionId: null }),
			run({ cost: 1 }),
		]);

		expect(summary.since).toBe(DAY);
	});
});

describe("fanOutBy", () => {
	it("splits by model, naming a run with no model as the settings default", () => {
		const slices = fanOutBy(
			[
				run({ model: "anthropic/claude-opus-5", cost: 8 }),
				run({ model: "", cost: 2 }),
			],
			"model",
		);

		expect(slices).toEqual([
			{ key: "anthropic/claude-opus-5", cost: 8, runs: 1 },
			{ key: "settings default", cost: 2, runs: 1 },
		]);
	});

	it("splits by UTC day of the run's start", () => {
		const slices = fanOutBy(
			[
				run({ startedAt: DAY + 1000, cost: 1 }),
				run({ startedAt: DAY - 1000, cost: 4 }),
			],
			"day",
		);

		expect(slices).toEqual([
			{ key: "2026-09-21", cost: 4, runs: 1 },
			{ key: "2026-09-22", cost: 1, runs: 1 },
		]);
	});
});

describe("fanOutView", () => {
	const records = [
		run({ kind: "council", model: "a", cost: 3 }),
		run({ kind: "fleet", model: "b", cost: 2 }),
		run({ kind: "judge", model: "c", cost: 1 }),
	];

	it("shows nothing extra when the report is not grouped", () => {
		expect(fanOutView(records, undefined, 12)).toBeUndefined();
	});

	it("groups by kind from the run store's own kind", () => {
		expect(fanOutView(records, "kind", 12)?.slices?.map((s) => s.key)).toEqual([
			"council",
			"fleet",
			"judge",
		]);
	});

	it("keeps to the limit the ledger slices use", () => {
		expect(fanOutView(records, "model", 2)?.slices).toHaveLength(2);
	});

	it("splits by the level each run launched at, keeping unknown apart", () => {
		// Unknown is a run from before the level was recorded, or one that
		// inherited pi's default, which the launching process cannot see.
		const view = fanOutView(
			[
				run({ thinkingLevel: "xhigh", cost: 5 }),
				run({ thinkingLevel: "high", cost: 9 }),
				run({ thinkingLevel: "xhigh", cost: 6 }),
				run({ thinkingLevel: null, cost: 2 }),
			],
			"thinking",
			12,
		);

		expect(view).toEqual({
			dimension: "thinking",
			named: 2,
			slices: [
				{ key: "xhigh", cost: 11, runs: 2 },
				{ key: "high", cost: 9, runs: 1 },
				{ key: "", cost: 2, runs: 1 },
			],
		});
	});

	it("offers no slices for a dimension the run store does not record", () => {
		expect(fanOutView(records, "weather", 12)).toEqual({
			dimension: "weather",
			unrecorded: true,
		});
	});
});

describe("fanOutView by where it was launched from", () => {
	const ledgerSession = (id: string, quest: string | null): SessionRecord => ({
		sessionId: `2026-09-21T20-14-04-474Z_${id}.jsonl`,
		cwd: "/src/repo",
		repo: "github.com/o/repo",
		quest,
		firstSeen: null,
		lastSeen: null,
	});
	const sessions = [
		ledgerSession("01a0", "QEST-A"),
		ledgerSession("01b0", null),
	];
	const records = [
		run({ sessionId: "01a0", repo: "github.com/o/repo", cost: 5 }),
		run({ sessionId: "01a0", repo: "github.com/o/repo", cost: 3 }),
		run({ sessionId: "01b0", repo: null, cost: 2 }),
		run({ sessionId: null, cost: 1 }),
	];

	it("splits by quest through the ledger's session, unattributed kept as a slice", () => {
		expect(fanOutView(records, "quest", 12, sessions)?.slices).toEqual([
			{ key: "QEST-A", cost: 8, runs: 2 },
			{ key: "", cost: 3, runs: 2 },
		]);
	});

	it("splits by repo from the run's own stamp", () => {
		expect(fanOutView(records, "repo", 12, sessions)?.slices).toEqual([
			{ key: "github.com/o/repo", cost: 8, runs: 2 },
			{ key: "", cost: 3, runs: 2 },
		]);
	});

	it("names a session the way the ledger does, so the two line up", () => {
		expect(fanOutView(records, "session", 1, sessions)?.slices).toEqual([
			{ key: "2026-09-21T20-14-04-474Z_01a0.jsonl", cost: 8, runs: 2 },
			{ key: "", cost: 1, runs: 1 },
		]);
	});

	it("keeps the unattributed slice even when the limit cuts the named ones", () => {
		const slices = fanOutView(records, "quest", 0, sessions)?.slices ?? [];
		expect(slices.map((s) => s.key)).toEqual([""]);
	});

	it("counts every named slice, not just the ones the limit shows", () => {
		expect(fanOutView(records, "quest", 0, sessions)?.named).toBe(1);
	});
});

describe("formatFanOut", () => {
	const summary = summarizeFanOut([
		run({ kind: "council", cost: 3653 }),
		run({ kind: "fleet", cost: 7527, sessionId: "01a0" }),
		run({ kind: "fleet", cost: null }),
	]);

	it("says plainly that the ledger total leaves fan-out out, and prices it", () => {
		const text = formatFanOut(summary);

		expect(text).toContain("not in the total above");
		expect(text).toContain("$11,180");
		expect(text).toContain("3 subagent runs");
		expect(text).toContain("council $3,653");
		expect(text).toContain("1 run carried no usage");
		expect(text).toContain("is counted");
	});

	it("names the day the run store starts, since the ledger reaches further back", () => {
		expect(formatFanOut(summary)).toContain("since 2026-09-22");
		expect(formatFanOut(summary)).not.toContain("with the main loop");
	});

	it("does not repeat the kind breakdown when grouping by kind", () => {
		const text = formatFanOut(summary, {
			dimension: "kind",
			slices: summary.byKind,
		});
		expect(text.match(/council/g)).toHaveLength(1);
	});

	it("says so when the run store does not record the dimension at all", () => {
		const text = formatFanOut(summary, {
			dimension: "weather",
			unrecorded: true,
		});

		expect(text).toContain("not split by weather");
		expect(text).toContain("does not record");
	});

	it("names the unattributed share of a split, as the ledger's slices do", () => {
		const text = formatFanOut(summary, {
			dimension: "quest",
			slices: [
				{ key: "QEST-A", cost: 7527, runs: 1 },
				{ key: "", cost: 3653, runs: 2 },
			],
		});

		expect(text).toContain(
			"Fan-out by quest (1 named, $3,653 unattributed, 33%)",
		);
		expect(text).toContain("QEST-A");
	});

	it("says how many named slices the limit left out", () => {
		const text = formatFanOut(summary, {
			dimension: "quest",
			named: 5,
			slices: [
				{ key: "QEST-A", cost: 7527, runs: 1 },
				{ key: "", cost: 3653, runs: 2 },
			],
		});

		expect(text).toContain("(5 named,");
		expect(text).toContain("4 more, ask for a larger limit");
	});

	it("lists fan-out slices for a dimension the run store does carry", () => {
		const text = formatFanOut(summary, {
			dimension: "model",
			slices: [{ key: "anthropic/claude-opus-5", cost: 11_180, runs: 3 }],
		});

		expect(text).toContain("Fan-out by model");
		expect(text).toContain("anthropic/claude-opus-5");
		expect(text).toContain("3 runs");
	});
});

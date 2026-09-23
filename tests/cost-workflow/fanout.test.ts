import type { RunRecord } from "@jitsusama/agentic-harness.core/observability";
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

	it("says how much of it can be traced to the session that launched it", () => {
		const summary = summarizeFanOut([
			run({ cost: 3, sessionId: "01a0" }),
			run({ cost: 7, sessionId: null }),
			run({ cost: 1 }),
		]);

		expect(summary.traced).toEqual({ runs: 1, cost: 3 });
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

	it("offers no slices for a dimension the run store cannot yet answer", () => {
		expect(fanOutView(records, "quest", 12)).toEqual({ dimension: "quest" });
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

	it("names how little can be split by quest rather than guessing", () => {
		const text = formatFanOut(summary, { dimension: "quest" });

		expect(text).toContain("not split by quest");
		expect(text).toContain("1 of 3 runs");
		expect(text).toContain("$7,527");
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

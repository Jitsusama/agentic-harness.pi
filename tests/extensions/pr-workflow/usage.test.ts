import { describe, expect, it } from "vitest";
import type { CritiqueRun } from "../../../extensions/pr-workflow/critique.js";
import type { CouncilRun } from "../../../extensions/pr-workflow/findings.js";
import type { JudgeRun } from "../../../extensions/pr-workflow/judge.js";
import type { ReviewerUsage } from "../../../extensions/pr-workflow/reviewer.js";
import {
	councilRunUsage,
	critiqueRunUsage,
	summarizeUsage,
	sumUsage,
} from "../../../extensions/pr-workflow/usage.js";

/**
 * `sumUsage` is the workhorse for cost reporting. The
 * status panel calls it across reviewer/judge/critique/fix
 * subagents; the fix action calls it across its own
 * queue. The helper has to:
 *
 *   - skip undefined entries rather than coerce to zero
 *     (zero spend is a real value; "no data" is not)
 *   - sum every token + cost channel element-wise so the
 *     status panel can show cache hit ratios without
 *     re-aggregating
 *   - return undefined when the input has no usage data
 *     at all, so the caller can render "no spend recorded"
 *     instead of "$0.00"
 */

function usage(over: Partial<ReviewerUsage>): ReviewerUsage {
	return {
		tokens: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
			...over.tokens,
		},
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
			...over.cost,
		},
	};
}

describe("sumUsage", () => {
	it("returns undefined for an empty list", () => {
		expect(sumUsage([])).toBeUndefined();
	});

	it("returns undefined when every entry is undefined", () => {
		// All-undefined means we never recorded usage for
		// anything; a "0" total would lie about the data.
		expect(sumUsage([undefined, undefined])).toBeUndefined();
	});

	it("skips undefined entries and sums the rest", () => {
		const a = usage({ tokens: { total: 100, input: 80, output: 20 } });
		const b = usage({ tokens: { total: 50, input: 40, output: 10 } });
		const result = sumUsage([a, undefined, b, undefined]);
		expect(result?.tokens.total).toBe(150);
		expect(result?.tokens.input).toBe(120);
		expect(result?.tokens.output).toBe(30);
	});

	it("sums every token channel element-wise", () => {
		const a = usage({
			tokens: {
				input: 10,
				output: 20,
				cacheRead: 30,
				cacheWrite: 40,
				total: 100,
			},
		});
		const b = usage({
			tokens: {
				input: 1,
				output: 2,
				cacheRead: 3,
				cacheWrite: 4,
				total: 10,
			},
		});
		const result = sumUsage([a, b]);
		expect(result?.tokens).toEqual({
			input: 11,
			output: 22,
			cacheRead: 33,
			cacheWrite: 44,
			total: 110,
		});
	});

	it("sums every cost channel element-wise", () => {
		const a = usage({
			cost: {
				input: 0.001,
				output: 0.002,
				cacheRead: 0,
				cacheWrite: 0.01,
				total: 0.013,
			},
		});
		const b = usage({
			cost: {
				input: 0.003,
				output: 0.004,
				cacheRead: 0,
				cacheWrite: 0.02,
				total: 0.027,
			},
		});
		const result = sumUsage([a, b]);
		expect(result?.cost.input).toBeCloseTo(0.004);
		expect(result?.cost.output).toBeCloseTo(0.006);
		expect(result?.cost.cacheWrite).toBeCloseTo(0.03);
		expect(result?.cost.total).toBeCloseTo(0.04);
	});

	it("preserves the canonical zero-shape when a single zero-usage entry is summed", () => {
		// One reviewer might legitimately do nothing
		// (e.g. cache-hit only). The aggregate should
		// still come back with all five token and cost
		// channels populated as zero rather than missing.
		const result = sumUsage([usage({})]);
		expect(result).toEqual({
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
	});
});

describe("councilRunUsage", () => {
	it("returns undefined for a null run", () => {
		expect(councilRunUsage(null)).toBeUndefined();
	});

	it("sums every reviewer output's usage", () => {
		const run: CouncilRun = {
			id: "r",
			startedAt: "x",
			target: { kind: "diff", prNumber: 1 },
			reviewerOutputs: [
				{
					reviewerId: "a",
					findings: [],
					warnings: [],
					usage: usage({ tokens: { total: 100 }, cost: { total: 0.01 } }),
				},
				{
					reviewerId: "b",
					findings: [],
					warnings: [],
					usage: usage({ tokens: { total: 200 }, cost: { total: 0.02 } }),
				},
			],
			worktreePath: "/tmp",
		};
		const result = councilRunUsage(run);
		expect(result?.tokens.total).toBe(300);
		expect(result?.cost.total).toBeCloseTo(0.03);
	});

	it("returns undefined when no reviewer surfaced usage", () => {
		const run: CouncilRun = {
			id: "r",
			startedAt: "x",
			target: { kind: "diff", prNumber: 1 },
			reviewerOutputs: [
				{ reviewerId: "a", findings: [], warnings: [] },
				{ reviewerId: "b", findings: [], warnings: [] },
			],
			worktreePath: "/tmp",
		};
		expect(councilRunUsage(run)).toBeUndefined();
	});
});

describe("critiqueRunUsage", () => {
	it("sums every reviewer critique output's usage", () => {
		const run: CritiqueRun = {
			id: "c",
			startedAt: "x",
			judgeRunId: "j",
			reviewerOutputs: [
				{
					reviewerId: "a",
					critiques: [],
					warnings: [],
					usage: usage({ tokens: { total: 40 } }),
				},
				{
					reviewerId: "b",
					critiques: [],
					warnings: [],
					usage: usage({ tokens: { total: 60 } }),
				},
			],
			warnings: [],
		};
		expect(critiqueRunUsage(run)?.tokens.total).toBe(100);
	});
});

describe("summarizeUsage", () => {
	it("breaks down by stage and totals across all three", () => {
		// status panel reads this directly; the breakdown
		// lets the user see which stage was expensive, the
		// total answers "what did this session cost?".
		const council: CouncilRun = {
			id: "r",
			startedAt: "x",
			target: { kind: "diff", prNumber: 1 },
			reviewerOutputs: [
				{
					reviewerId: "a",
					findings: [],
					warnings: [],
					usage: usage({ tokens: { total: 1000 }, cost: { total: 0.1 } }),
				},
			],
			worktreePath: "/tmp",
		};
		const judge: JudgeRun = {
			id: "j",
			startedAt: "x",
			judgeReviewerId: "jd",
			selfSignal: null,
			consolidatedFindings: [],
			warnings: [],
			usage: usage({ tokens: { total: 200 }, cost: { total: 0.02 } }),
		};
		const critique: CritiqueRun = {
			id: "c",
			startedAt: "x",
			judgeRunId: "j",
			reviewerOutputs: [
				{
					reviewerId: "a",
					critiques: [],
					warnings: [],
					usage: usage({ tokens: { total: 100 }, cost: { total: 0.01 } }),
				},
			],
			warnings: [],
		};
		const breakdown = summarizeUsage({ council, judge, critique });
		expect(breakdown.council?.tokens.total).toBe(1000);
		expect(breakdown.judge?.tokens.total).toBe(200);
		expect(breakdown.critique?.tokens.total).toBe(100);
		expect(breakdown.total?.tokens.total).toBe(1300);
		expect(breakdown.total?.cost.total).toBeCloseTo(0.13);
	});

	it("reports total as undefined when every stage is null/undefined", () => {
		const breakdown = summarizeUsage({
			council: null,
			judge: null,
			critique: null,
		});
		expect(breakdown.total).toBeUndefined();
	});
});

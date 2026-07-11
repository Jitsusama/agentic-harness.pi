import { describe, expect, it } from "vitest";
import {
	formatDigest,
	groupByRun,
} from "../../../extensions/observability-workflow/index.js";
import type {
	RunRecord,
	RunRollup,
	VerifyOutcome,
} from "../../../lib/observability/index.js";

const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

function row(runId: string, verifyOutcome: VerifyOutcome, cost = 1): RunRecord {
	return {
		runId,
		subagentId: `${runId}-a`,
		kind: "fleet",
		model: "m",
		persona: "p",
		verifyOutcome,
		retriesToValid: 0,
		warningCount: 0,
		exitCode: 0,
		tokens: ZERO,
		cost: { ...ZERO, total: cost },
		startedAt: 0,
	};
}

describe("groupByRun", () => {
	it("collapses rows sharing a run and sums their counts", () => {
		const groups = groupByRun([
			row("r1", "passed", 1),
			row("r1", "failed", 2),
			row("r2", "passed", 4),
		]);

		const r1 = groups.find((g) => g.runId === "r1");
		expect(r1).toMatchObject({
			subagentCount: 2,
			passed: 1,
			failed: 1,
			cost: 3,
		});
		expect(groups).toHaveLength(2);
	});
});

describe("formatDigest", () => {
	it("reports the empty state with no rows or rollups", () => {
		expect(formatDigest([], [])).toBe("No runs recorded yet.");
	});

	it("caps the recent-run list at ten while counting the whole window", () => {
		const rows = Array.from({ length: 12 }, (_, i) =>
			row(`r${i}`, "passed", 1),
		);

		const digest = formatDigest(rows, []);

		expect(digest).toContain("Recent runs (12 in window):");
		// Only ten run lines render despite twelve runs in the window.
		expect(digest.match(/ subagents,/g)).toHaveLength(10);
	});

	it("renders a weekly rollup with a model fallback and cache percentage", () => {
		const rollup: RunRollup = {
			weekStart: Date.UTC(2026, 0, 5),
			model: "",
			persona: "reviewer",
			runCount: 3,
			totalRetries: 1,
			totalWarnings: 0,
			tokensTotal: 100,
			costTotal: 1.5,
			cacheReadRatio: 0.5,
		};

		const digest = formatDigest([], [rollup]);

		expect(digest).toContain("(default)");
		expect(digest).toContain("cache-read 50%");
	});
});

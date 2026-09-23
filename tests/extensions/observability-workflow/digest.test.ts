import type {
	RunRecord,
	RunRollup,
	VerifyOutcome,
} from "@jitsusama/agentic-harness.core/observability";
import { cleanupSessionResults } from "@jitsusama/agentic-harness.core/result";
import { afterEach, describe, expect, it } from "vitest";
import {
	boundedDigest,
	formatDigest,
	groupByRun,
} from "../../../extensions/observability-workflow/index.ts";

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
		thinkingLevel: null,
		subagentSessionIds: null,
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

describe("boundedDigest", () => {
	afterEach(() => {
		cleanupSessionResults();
	});

	function rollup(week: number, persona: string): RunRollup {
		return {
			weekStart: Date.UTC(2026, 0, 1) + week * 7 * 86_400_000,
			model: "anthropic/claude-opus-5",
			persona,
			runCount: 3,
			totalRetries: 0,
			totalWarnings: 0,
			tokensTotal: 1000,
			costTotal: 1.5,
			cacheReadRatio: 0.5,
		};
	}

	it("returns a small digest untouched", () => {
		const rollups = [rollup(0, "correctness")];
		expect(boundedDigest([], rollups)).toBe(formatDigest([], rollups));
	});

	it("bounds a digest whose weekly trends have grown past the budget, keeping every one queryable", () => {
		// The real failure: rollups are computed over every row ever kept,
		// one line per week, model and persona, so the digest grew without
		// limit and one call answered with 140,393 characters.
		const rollups = Array.from({ length: 40 }, (_, week) =>
			Array.from({ length: 22 }, (_, p) => rollup(week, `persona-${p}`)),
		).flat();
		const whole = formatDigest([], rollups);

		const bounded = boundedDigest([], rollups);

		expect(Buffer.byteLength(bounded, "utf-8")).toBeLessThan(
			Buffer.byteLength(whole, "utf-8") / 5,
		);
		expect(bounded).toMatch(/handle result-[0-9a-f]{16}/);
	});
});

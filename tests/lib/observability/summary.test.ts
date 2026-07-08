import { describe, expect, it } from "vitest";
import { openRunStore, type RunRecord } from "../../../lib/observability";

function run(overrides: Partial<RunRecord> = {}): RunRecord {
	return {
		runId: "council-1",
		subagentId: "s",
		kind: "council",
		model: "anthropic/claude-opus-4-8",
		persona: "reviewer",
		verifyOutcome: "passed",
		retriesToValid: 0,
		warningCount: 0,
		exitCode: 0,
		tokens: {
			input: 100,
			output: 40,
			cacheRead: 100,
			cacheWrite: 0,
			total: 240,
		},
		cost: {
			input: 0.1,
			output: 0.2,
			cacheRead: 0.01,
			cacheWrite: 0,
			total: 0.31,
		},
		startedAt: 1_700_000_000_000,
		...overrides,
	};
}

describe("RunStore.summarizeRun", () => {
	it("aggregates a run's subagents into counts, totals and a cache-read ratio", async () => {
		const store = await openRunStore(":memory:");
		await store.recordRun(
			run({ subagentId: "a", verifyOutcome: "passed", retriesToValid: 1 }),
		);
		await store.recordRun(
			run({ subagentId: "b", verifyOutcome: "failed", warningCount: 2 }),
		);

		const summary = await store.summarizeRun("council-1");

		expect(summary).not.toBeNull();
		expect(summary?.subagentCount).toBe(2);
		expect(summary?.passed).toBe(1);
		expect(summary?.failed).toBe(1);
		expect(summary?.totalRetries).toBe(1);
		expect(summary?.totalWarnings).toBe(2);
		expect(summary?.tokens.total).toBe(480);
		expect(summary?.cost.total).toBeCloseTo(0.62);
		// cacheRead / (input + cacheRead) = 200 / (200 + 200)
		expect(summary?.cacheReadRatio).toBeCloseTo(0.5);
		await store.close();
	});

	it("returns null for an unknown run", async () => {
		const store = await openRunStore(":memory:");
		expect(await store.summarizeRun("nope")).toBeNull();
		await store.close();
	});
});

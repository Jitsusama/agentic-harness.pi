import { describe, expect, it } from "vitest";
import { openRunStore, type RunRecord } from "../../../lib/observability";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function run(overrides: Partial<RunRecord> = {}): RunRecord {
	return {
		runId: "r",
		subagentId: "s",
		kind: "council",
		model: "opus",
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

describe("RunStore rollup", () => {
	it("merges same-bucket rows, buckets by week/model/persona, and drops the raw rows", async () => {
		const store = await openRunStore(":memory:");
		const week1 = 1_700_000_000_000;
		const week2 = week1 + 8 * 24 * 60 * 60 * 1000;
		await store.recordRun(
			run({ subagentId: "a", startedAt: week1, retriesToValid: 1 }),
		);
		await store.recordRun(
			run({
				subagentId: "b",
				startedAt: week1 + 3_600_000,
				retriesToValid: 2,
				warningCount: 1,
			}),
		);
		await store.recordRun(
			run({ subagentId: "c", startedAt: week2, persona: "other" }),
		);

		const result = await store.rollupBefore(week2 + 24 * 60 * 60 * 1000);

		expect(result.rolledRows).toBe(3);
		expect(await store.queryRuns()).toEqual([]);

		const rollups = await store.queryRollups();
		expect(rollups).toHaveLength(2);
		const merged = rollups.find((r) => r.persona === "reviewer");
		expect(merged?.weekStart).toBe(Math.floor(week1 / WEEK_MS) * WEEK_MS);
		expect(merged?.runCount).toBe(2);
		expect(merged?.totalRetries).toBe(3);
		expect(merged?.totalWarnings).toBe(1);
		expect(merged?.tokensTotal).toBe(480);
		expect(merged?.costTotal).toBeCloseTo(0.62);
		expect(merged?.cacheReadRatio).toBeCloseTo(0.5);
		const other = rollups.find((r) => r.persona === "other");
		expect(other?.runCount).toBe(1);
		await store.close();
	});

	it("leaves rows newer than the cutoff untouched and merges into an existing bucket", async () => {
		const store = await openRunStore(":memory:");
		const week1 = 1_700_000_000_000;
		await store.recordRun(run({ subagentId: "a", startedAt: week1 }));
		await store.rollupBefore(week1 + 1);
		// A second old row in the same bucket, rolled later, must
		// add to the existing rollup rather than create a new one.
		await store.recordRun(
			run({ subagentId: "b", startedAt: week1 + 1000, retriesToValid: 5 }),
		);
		await store.recordRun(
			run({ subagentId: "fresh", startedAt: week1 + 100 * WEEK_MS }),
		);

		await store.rollupBefore(week1 + 2000);

		const rollups = await store.queryRollups();
		expect(rollups).toHaveLength(1);
		expect(rollups[0].runCount).toBe(2);
		expect(rollups[0].totalRetries).toBe(5);
		// The fresh row is newer than the cutoff, so it stays raw.
		expect(await store.queryRuns()).toHaveLength(1);
		expect((await store.queryRuns())[0].subagentId).toBe("fresh");
		await store.close();
	});
});

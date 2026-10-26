import { describe, expect, it } from "vitest";
import {
	openRunStore,
	type RunRecord,
} from "../../../lib/core/observability/index.ts";

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
		thinkingLevel: null,
		subagentSessionIds: null,
		...overrides,
	};
}

describe("RunStore summaries", () => {
	it("keeps every row, however old, and summarises without deleting", async () => {
		// Rolling up and deleting destroyed the detail behind 2,199 runs
		// and $11,926 before this was noticed. The corpus is a rounding
		// error on disk, so there is no case for discarding any of it.
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

		const rollups = await store.queryRollups();

		expect(await store.queryRuns()).toHaveLength(3);
		expect(rollups).toHaveLength(2);
		const merged = rollups.find((r) => r.persona === "reviewer");
		expect(merged?.weekStart).toBe(Math.floor(week1 / WEEK_MS) * WEEK_MS);
		expect(merged?.runCount).toBe(2);
		expect(merged?.totalRetries).toBe(3);
		expect(merged?.totalWarnings).toBe(1);
		expect(merged?.tokensTotal).toBe(480);
		expect(merged?.costTotal).toBeCloseTo(0.62);
		expect(merged?.cacheReadRatio).toBeCloseTo(0.5);
		expect(rollups.find((r) => r.persona === "other")?.runCount).toBe(1);
		await store.close();
	});

	it("buckets by week, model and persona together", async () => {
		const store = await openRunStore(":memory:");
		const week1 = 1_700_000_000_000;
		await store.recordRun(run({ subagentId: "a", startedAt: week1 }));
		await store.recordRun(
			run({ subagentId: "b", startedAt: week1 + 1000, model: "sonnet" }),
		);
		await store.recordRun(
			run({ subagentId: "c", startedAt: week1 + 60 * WEEK_MS }),
		);

		expect(await store.queryRollups()).toHaveLength(3);
		await store.close();
	});

	it("reports a summary that is current the moment a row lands", async () => {
		// Computing rather than materialising means there is no pass to
		// wait for and no window in which the answer is stale.
		const store = await openRunStore(":memory:");
		await store.recordRun(run({ subagentId: "a" }));
		expect((await store.queryRollups())[0].runCount).toBe(1);

		await store.recordRun(run({ subagentId: "b" }));
		expect((await store.queryRollups())[0].runCount).toBe(2);
		await store.close();
	});

	it("has nothing to say about an empty store", async () => {
		const store = await openRunStore(":memory:");
		expect(await store.queryRollups()).toEqual([]);
		await store.close();
	});
});

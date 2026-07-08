import { describe, expect, it } from "vitest";
import { openRunStore, type RunRecord } from "../../../lib/observability";

function sampleRun(overrides: Partial<RunRecord> = {}): RunRecord {
	return {
		runId: "council-1",
		subagentId: "security",
		kind: "council",
		model: "anthropic/claude-opus-4-8",
		persona: "security-reviewer",
		verifyOutcome: "passed",
		retriesToValid: 1,
		warningCount: 0,
		exitCode: 0,
		tokens: {
			input: 100,
			output: 40,
			cacheRead: 20,
			cacheWrite: 10,
			total: 170,
		},
		cost: {
			input: 0.1,
			output: 0.2,
			cacheRead: 0.01,
			cacheWrite: 0.02,
			total: 0.33,
		},
		startedAt: 1_700_000_000_000,
		...overrides,
	};
}

describe("RunStore", () => {
	it("round-trips a run record through SQLite with every field intact", async () => {
		const store = await openRunStore(":memory:");
		const record = sampleRun();

		await store.recordRun(record);
		const rows = await store.queryRuns();

		expect(rows).toEqual([record]);
		await store.close();
	});

	it("filters rows by run id", async () => {
		const store = await openRunStore(":memory:");
		await store.recordRun(sampleRun({ runId: "a", subagentId: "s1" }));
		await store.recordRun(sampleRun({ runId: "b", subagentId: "s2" }));

		const rows = await store.queryRuns({ runId: "b" });

		expect(rows).toHaveLength(1);
		expect(rows[0].runId).toBe("b");
		expect(rows[0].subagentId).toBe("s2");
		await store.close();
	});
});

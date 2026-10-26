import { describe, expect, it } from "vitest";
import {
	openRunStore,
	type RunRecordInput,
	runRecordFrom,
} from "../../../lib/core/observability/index.ts";

const USAGE = {
	tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
	cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
};

function input(overrides: Partial<RunRecordInput> = {}): RunRecordInput {
	return {
		runId: "council-1",
		subagentId: "correctness",
		kind: "council",
		model: "anthropic/claude-opus-5",
		persona: "correctness",
		thinkingLevel: null,
		startedAt: 1_700_000_000_000,
		result: { exitCode: 0, sessionIds: null, warnings: [], usage: USAGE },
		...overrides,
	};
}

describe("a run that reported no usage", () => {
	it("still gets a record, so a round killed before billing is not invisible", () => {
		const record = runRecordFrom(
			input({ result: { exitCode: 1, sessionIds: null, warnings: [] } }),
		);

		expect(record.runId).toBe("council-1");
		expect(record.exitCode).toBe(1);
	});

	it("carries an unknown cost rather than a zero one", () => {
		// All 75 zero-cost rows in the real store also had zero tokens, so
		// none was free: each died before it could report. Recording them
		// at $0 made them indistinguishable from a run that cost nothing.
		const record = runRecordFrom(
			input({ result: { exitCode: 1, sessionIds: null, warnings: [] } }),
		);

		expect(record.cost).toBeNull();
		expect(record.tokens).toBeNull();
	});

	it("reads back as unknown after a round trip through the store", async () => {
		const store = await openRunStore(":memory:");
		await store.recordRun(
			runRecordFrom(
				input({ result: { exitCode: 1, sessionIds: null, warnings: [] } }),
			),
		);

		const [row] = await store.queryRuns();
		expect(row.cost).toBeNull();
		await store.close();
	});

	it("is counted in the run's summary rather than folded into its total", async () => {
		const store = await openRunStore(":memory:");
		await store.recordRun(runRecordFrom(input({ subagentId: "a" })));
		await store.recordRun(
			runRecordFrom(
				input({
					subagentId: "b",
					result: { exitCode: 1, sessionIds: null, warnings: [] },
				}),
			),
		);

		const summary = await store.summarizeRun("council-1");
		expect(summary?.subagentCount).toBe(2);
		expect(summary?.unmetered).toBe(1);
		expect(summary?.cost.total).toBeCloseTo(0.3, 5);
		await store.close();
	});

	it("leaves a metered run exactly as it was", async () => {
		const store = await openRunStore(":memory:");
		await store.recordRun(runRecordFrom(input()));

		const [row] = await store.queryRuns();
		expect(row.cost?.total).toBeCloseTo(0.3, 5);
		expect(row.tokens?.total).toBe(15);
		await store.close();
	});
});

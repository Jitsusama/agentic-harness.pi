import { describe, expect, it } from "vitest";
import {
	openRunStore,
	type RunRecord,
} from "../../../lib/core/observability/index.ts";

function run(overrides: Partial<RunRecord> = {}): RunRecord {
	return {
		runId: "council-1",
		subagentId: "correctness",
		kind: "council",
		model: "anthropic/claude-opus-5",
		persona: "correctness",
		verifyOutcome: "none",
		retriesToValid: 0,
		warningCount: 0,
		exitCode: 0,
		tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
		cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0, total: 0.2 },
		startedAt: 1_700_000_000_000,
		thinkingLevel: null,
		subagentSessionIds: null,
		...overrides,
	};
}

describe("run attribution", () => {
	it("records which session, directory and repo a run belonged to", async () => {
		// $12,825 of fan-out could not be traced to the work that caused
		// it, because a run row said what it cost but not what for.
		const store = await openRunStore(":memory:");
		await store.recordRun(
			run({
				sessionId: "019fe2c6-b46e",
				cwd: "/Users/j/world/trees/root/src/system/gitstream",
				repo: "world/system/gitstream",
				endedAt: 1_700_000_090_000,
			}),
		);

		const [row] = await store.queryRuns();
		expect(row.sessionId).toBe("019fe2c6-b46e");
		expect(row.cwd).toBe("/Users/j/world/trees/root/src/system/gitstream");
		expect(row.repo).toBe("world/system/gitstream");
		expect(row.endedAt).toBe(1_700_000_090_000);
		await store.close();
	});

	it("holds nothing rather than guessing when attribution was not known", async () => {
		const store = await openRunStore(":memory:");
		await store.recordRun(run());

		const [row] = await store.queryRuns();
		expect(row.sessionId).toBeNull();
		expect(row.repo).toBeNull();
		expect(row.endedAt).toBeNull();
		await store.close();
	});
});

describe("how a run was launched", () => {
	it("records the thinking level and every session the subagent's processes announced", async () => {
		// Billing rows carry the child process's pi session id, not the
		// parent's, so without it a job can only be matched to its bill by
		// summing tokens, which misses whenever one side has a call the
		// other lacks. The thinking level is the other half of what a job
		// cost: 30 percent of fleet jobs launch at xhigh. A job can be more
		// than one process, since a stopped reviewer is asked for its
		// findings by a second one, so it can hold more than one session.
		const store = await openRunStore(":memory:");
		await store.recordRun(
			run({
				thinkingLevel: "xhigh",
				subagentSessionIds: [
					"01a0cff2-4244-75ad-b91b-7bdc1bc970b7",
					"01a0cff9-7f1e-7c2a-9d3e-2a1b8e0c4f51",
				],
			}),
		);

		const [row] = await store.queryRuns();
		expect(row.thinkingLevel).toBe("xhigh");
		expect(row.subagentSessionIds).toEqual([
			"01a0cff2-4244-75ad-b91b-7bdc1bc970b7",
			"01a0cff9-7f1e-7c2a-9d3e-2a1b8e0c4f51",
		]);
		await store.close();
	});

	it("tells a run with no child process apart from one nobody knew", async () => {
		// An in-process run, like the advisor, had no child to announce a
		// session. That is a fact, not a gap, and reads differently.
		const store = await openRunStore(":memory:");
		await store.recordRun(run({ subagentSessionIds: [] }));

		const [row] = await store.queryRuns();
		expect(row.subagentSessionIds).toEqual([]);
		await store.close();
	});

	it("holds nothing when the launch was not known", async () => {
		const store = await openRunStore(":memory:");
		await store.recordRun(run());

		const [row] = await store.queryRuns();
		expect(row.thinkingLevel).toBeNull();
		expect(row.subagentSessionIds).toBeNull();
		await store.close();
	});
});

describe("run identity", () => {
	it("keeps one row per subagent of a run, holding the later record", async () => {
		// A retried subagent or a replayed record would otherwise be
		// billed twice, which is the same double count forked session
		// logs caused in the main-loop totals.
		const store = await openRunStore(":memory:");
		await store.recordRun(run({ exitCode: 1, cost: null, tokens: null }));
		await store.recordRun(run({ exitCode: 0 }));

		const rows = await store.queryRuns();
		expect(rows).toHaveLength(1);
		expect(rows[0].exitCode).toBe(0);
		expect(rows[0].cost?.total).toBeCloseTo(0.2, 5);
		await store.close();
	});

	it("still keeps separate subagents of one run apart", async () => {
		const store = await openRunStore(":memory:");
		await store.recordRun(run({ subagentId: "a" }));
		await store.recordRun(run({ subagentId: "b" }));

		expect(await store.queryRuns()).toHaveLength(2);
		await store.close();
	});
});

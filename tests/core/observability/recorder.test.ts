import { describe, expect, it } from "vitest";
import { runRecordFrom } from "../../../lib/core/observability/index.ts";

describe("runRecordFrom", () => {
	it("maps a verified run with usage into a full record", () => {
		const record = runRecordFrom({
			runId: "council-1",
			subagentId: "security",
			kind: "council",
			model: "opus",
			persona: "security-reviewer",
			thinkingLevel: null,
			startedAt: 1_700_000_000_000,
			result: {
				exitCode: 0,
				sessionIds: null,
				warnings: ["w1", "w2"],
				usage: {
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
				},
				verification: { ok: true },
			},
		});

		expect(record.verifyOutcome).toBe("passed");
		expect(record.warningCount).toBe(2);
		expect(record.tokens?.total).toBe(170);
		expect(record.cost?.total).toBeCloseTo(0.33);
		expect(record.retriesToValid).toBe(0);
	});

	it("carries the launch's thinking level and the session the child reported", () => {
		const record = runRecordFrom({
			runId: "fleet-1",
			subagentId: "implement",
			kind: "fleet",
			model: "anthropic/claude-opus-5-5",
			persona: "implement",
			thinkingLevel: "medium",
			startedAt: 1_700_000_000_000,
			result: {
				exitCode: 0,
				warnings: [],
				sessionIds: ["01a0cff2-4244-75ad-b91b-7bdc1bc970b7"],
			},
		});

		expect(record.thinkingLevel).toBe("medium");
		expect(record.subagentSessionIds).toEqual([
			"01a0cff2-4244-75ad-b91b-7bdc1bc970b7",
		]);
	});

	it("derives retries-to-valid from the verify attempt count", () => {
		const base = {
			runId: "r",
			subagentId: "s",
			kind: "council",
			model: "",
			persona: "s",
			thinkingLevel: null,
			startedAt: 0,
		};
		const firstTry = runRecordFrom({
			...base,
			result: {
				exitCode: 0,
				sessionIds: null,
				warnings: [],
				verification: { ok: true, attempts: 1 },
			},
		});
		expect(firstTry.retriesToValid).toBe(0);

		const retried = runRecordFrom({
			...base,
			result: {
				exitCode: 0,
				sessionIds: null,
				warnings: [],
				verification: { ok: true, attempts: 3 },
			},
		});
		expect(retried.retriesToValid).toBe(2);
	});

	it("marks a failed verification and leaves usage unknown when the run carried none", () => {
		const failed = runRecordFrom({
			runId: "r",
			subagentId: "s",
			kind: "fleet",
			model: "",
			persona: "s",
			thinkingLevel: null,
			startedAt: 0,
			result: {
				exitCode: 1,
				sessionIds: null,
				warnings: [],
				verification: { ok: false },
			},
		});
		expect(failed.verifyOutcome).toBe("failed");
		// Unknown, not zero: this run reported no usage, so what it cost
		// is not known, and a zero would claim it was free.
		expect(failed.tokens).toBeNull();
		expect(failed.cost).toBeNull();

		const noVerify = runRecordFrom({
			runId: "r",
			subagentId: "s",
			kind: "fleet",
			model: "",
			persona: "s",
			thinkingLevel: null,
			startedAt: 0,
			result: { exitCode: 0, sessionIds: null, warnings: [] },
		});
		expect(noVerify.verifyOutcome).toBe("none");
	});
});

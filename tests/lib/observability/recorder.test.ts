import { describe, expect, it } from "vitest";
import { runRecordFrom } from "../../../lib/observability";

describe("runRecordFrom", () => {
	it("maps a verified run with usage into a full record", () => {
		const record = runRecordFrom({
			runId: "council-1",
			subagentId: "security",
			kind: "council",
			model: "opus",
			persona: "security-reviewer",
			startedAt: 1_700_000_000_000,
			result: {
				exitCode: 0,
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
		expect(record.tokens.total).toBe(170);
		expect(record.cost.total).toBeCloseTo(0.33);
		expect(record.retriesToValid).toBe(0);
	});

	it("derives retries-to-valid from the verify attempt count", () => {
		const base = {
			runId: "r",
			subagentId: "s",
			kind: "council",
			model: "",
			persona: "s",
			startedAt: 0,
		};
		const firstTry = runRecordFrom({
			...base,
			result: {
				exitCode: 0,
				warnings: [],
				verification: { ok: true, attempts: 1 },
			},
		});
		expect(firstTry.retriesToValid).toBe(0);

		const retried = runRecordFrom({
			...base,
			result: {
				exitCode: 0,
				warnings: [],
				verification: { ok: true, attempts: 3 },
			},
		});
		expect(retried.retriesToValid).toBe(2);
	});

	it("marks a failed verification and zeroes usage when the run carried none", () => {
		const failed = runRecordFrom({
			runId: "r",
			subagentId: "s",
			kind: "fleet",
			model: "",
			persona: "s",
			startedAt: 0,
			result: { exitCode: 1, warnings: [], verification: { ok: false } },
		});
		expect(failed.verifyOutcome).toBe("failed");
		expect(failed.tokens).toEqual({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		});
		expect(failed.cost.total).toBe(0);

		const noVerify = runRecordFrom({
			runId: "r",
			subagentId: "s",
			kind: "fleet",
			model: "",
			persona: "s",
			startedAt: 0,
			result: { exitCode: 0, warnings: [] },
		});
		expect(noVerify.verifyOutcome).toBe("none");
	});
});

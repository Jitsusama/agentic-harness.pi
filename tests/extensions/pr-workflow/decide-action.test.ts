import { describe, expect, it } from "vitest";
import { decideBatchAction } from "../../../extensions/pr-workflow/decide-action.js";
import type { Finding } from "../../../extensions/pr-workflow/findings.js";
import type { JudgeRun } from "../../../extensions/pr-workflow/judge.js";
import { createPrWorkflowState } from "../../../extensions/pr-workflow/state.js";

function finding(id: number): Finding {
	return {
		id,
		location: { kind: "global" },
		label: "issue",
		decorations: [],
		subject: `s${id}`,
		discussion: "d",
		category: "scope",
		origin: { kind: "judge", runId: "j-1", judgeReviewerId: "j" },
		state: "draft",
		agreement: { raisedBy: ["fast"], sourceFindingIds: [] },
	};
}

function judge(findings: Finding[]): JudgeRun {
	return {
		id: "j-1",
		startedAt: "2026-01-01T00:00:00Z",
		judgeReviewerId: "j",
		selfSignal: null,
		consolidatedFindings: findings,
		warnings: [],
	};
}

describe("decideBatchAction", () => {
	it("rejects a missing verdict", () => {
		const state = createPrWorkflowState();
		state.council.lastJudge = judge([finding(1)]);
		const result = decideBatchAction(state, { findingIds: [1] });
		expect(result.isError).toBe(true);
		expect(result.summary).toMatch(/verdict/i);
	});

	it("rejects the edit verdict as non-batchable", () => {
		const state = createPrWorkflowState();
		state.council.lastJudge = judge([finding(1)]);
		const result = decideBatchAction(state, {
			findingIds: [1],
			verdict: "edit",
		});
		expect(result.isError).toBe(true);
		expect(result.summary).toMatch(/edit|batch/i);
	});

	it("summarizes a successful batch", () => {
		const state = createPrWorkflowState();
		state.council.lastJudge = judge([finding(1), finding(2)]);
		const result = decideBatchAction(state, {
			findingIds: [1, 2],
			verdict: "endorse",
		});
		expect(result.isError).toBe(false);
		expect(result.summary).toContain("2");
		expect(state.council.decisions.get(2)?.verdict).toBe("endorse");
	});

	it("names failed ids and errors when nothing landed", () => {
		const state = createPrWorkflowState();
		state.council.lastJudge = judge([finding(1)]);
		const result = decideBatchAction(state, {
			findingIds: [998, 999],
			verdict: "endorse",
		});
		expect(result.isError).toBe(true);
		expect(result.summary).toContain("999");
	});
});

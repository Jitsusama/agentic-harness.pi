import { describe, expect, it } from "vitest";
import { addManualFindingAction } from "../../../extensions/pr-workflow/manual-finding-action.js";
import { createPrWorkflowState } from "../../../extensions/pr-workflow/state.js";
import { expectFailure } from "./fixtures.js";

function stateWithJudge() {
	const state = createPrWorkflowState();
	state.nextFindingId = 10;
	state.council.lastJudge = {
		id: "judge-run",
		startedAt: "2026-01-01T00:00:00Z",
		judgeReviewerId: "judge",
		selfSignal: null,
		consolidatedFindings: [],
		warnings: [],
	};
	return state;
}

describe("addManualFindingAction", () => {
	it("appends a user-origin line finding to the current judge run", () => {
		const state = stateWithJudge();
		const result = addManualFindingAction({
			state,
			label: "suggestion",
			decorations: [" blocking ", ""],
			subject: " use `force-push` as the restrict value ",
			discussion: " `non_fast_forward` is Git plumbing terminology. ",
			file: "system/gitstream/policies/schemas/protected-refs-policy.schema.json",
			start: 47,
			side: "new",
			severity: "medium",
			confidence: 0.9,
			originNote: "user drafted this during synthesis",
		});

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.error);
		expect(result.finding).toMatchObject({
			id: 10,
			label: "suggestion",
			decorations: ["blocking"],
			subject: "use `force-push` as the restrict value",
			discussion: "`non_fast_forward` is Git plumbing terminology.",
			location: {
				kind: "line",
				file: "system/gitstream/policies/schemas/protected-refs-policy.schema.json",
				start: 47,
				end: 47,
				side: "new",
			},
			category: "file",
			severity: "medium",
			confidence: 0.9,
			origin: {
				kind: "user",
				note: "user drafted this during synthesis",
			},
			state: "draft",
		});
		expect(state.nextFindingId).toBe(11);
		expect(state.council.lastJudge?.consolidatedFindings).toEqual([
			result.finding,
		]);
	});

	it("creates file-level and global findings when no line is supplied", () => {
		const state = stateWithJudge();
		const fileResult = addManualFindingAction({
			state,
			label: "question",
			subject: "Clarify schema wording",
			discussion: "The file-level contract could use an example.",
			file: "policy.schema.json",
		});
		const globalResult = addManualFindingAction({
			state,
			label: "note",
			subject: "Review context",
			discussion: "This applies to the whole PR.",
		});

		expect(fileResult.ok).toBe(true);
		expect(globalResult.ok).toBe(true);
		if (!fileResult.ok || !globalResult.ok)
			throw new Error("unexpected failure");
		expect(fileResult.finding.location).toEqual({
			kind: "file",
			file: "policy.schema.json",
		});
		expect(fileResult.finding.category).toBe("file");
		expect(globalResult.finding.location).toEqual({ kind: "global" });
		expect(globalResult.finding.category).toBe("scope");
	});

	it("rejects manual findings before a judge run exists", () => {
		const state = createPrWorkflowState();
		const result = addManualFindingAction({
			state,
			label: "suggestion",
			subject: "Use force-push",
			discussion: "Prefer operator-facing terminology.",
		});

		expect(expectFailure(result).error).toContain(
			"No judge findings available",
		);
	});

	it("validates inline locations", () => {
		const state = stateWithJudge();
		const result = addManualFindingAction({
			state,
			label: "suggestion",
			subject: "Use force-push",
			discussion: "Prefer operator-facing terminology.",
			file: "policy.schema.json",
			start: 12,
			end: 11,
		});

		expect(expectFailure(result).error).toContain(
			"greater than or equal to `start`",
		);
		expect(state.council.lastJudge?.consolidatedFindings).toHaveLength(0);
		expect(state.nextFindingId).toBe(10);
	});
});

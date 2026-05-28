import { describe, expect, it } from "vitest";
import type { Finding } from "../../../extensions/pr-workflow/findings.js";
import type { JudgeRun } from "../../../extensions/pr-workflow/judge.js";
import { hasFindingsForParticipant } from "../../../extensions/pr-workflow/participant-identities.js";
import { createPrWorkflowState } from "../../../extensions/pr-workflow/state.js";

function judgeFinding(overrides: Partial<Finding>): Finding {
	return {
		id: 1,
		label: "issue",
		subject: "x",
		discussion: "y",
		location: { kind: "file", file: "a.ts" },
		origin: {
			kind: "judge",
			judgeRunId: "j",
			judgeReviewerId: "judge",
			sourceFindingIds: [],
		},
		...overrides,
	} as Finding;
}

describe("hasFindingsForParticipant", () => {
	it("returns true when a council finding's reviewerId matches", () => {
		const state = createPrWorkflowState();
		state.council.lastJudge = {
			id: "j",
			startedAt: "x",
			judgeReviewerId: "judge",
			selfSignal: null,
			consolidatedFindings: [],
			warnings: [],
		} as JudgeRun;
		state.council.lastRun = {
			id: "r",
			startedAt: "x",
			target: { kind: "diff", prNumber: 1 },
			reviewerOutputs: [
				{
					reviewerId: "opus",
					findings: [
						judgeFinding({
							origin: {
								kind: "council",
								runId: "r",
								reviewerId: "opus",
							},
						}),
					],
					warnings: [],
				},
			],
		};
		expect(hasFindingsForParticipant(state, "opus")).toBe(true);
		expect(hasFindingsForParticipant(state, "gpt")).toBe(false);
	});

	it("also reports true when a judge finding's agreement.raisedBy lists the id", () => {
		// Releasing a council reviewer's identity lock must
		// notice that judge consolidation kept their id in
		// the agreement metadata, otherwise the summary
		// lies about whether old findings still reference
		// the freed id.
		const state = createPrWorkflowState();
		state.council.lastJudge = {
			id: "j",
			startedAt: "x",
			judgeReviewerId: "judge",
			selfSignal: null,
			consolidatedFindings: [
				judgeFinding({
					agreement: { raisedBy: ["opus", "gpt"], sourceFindingIds: [] },
				}),
			],
			warnings: [],
		} as JudgeRun;
		expect(hasFindingsForParticipant(state, "opus")).toBe(true);
		expect(hasFindingsForParticipant(state, "gpt")).toBe(true);
		expect(hasFindingsForParticipant(state, "grok")).toBe(false);
	});
});

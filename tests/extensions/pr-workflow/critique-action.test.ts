import { describe, expect, it } from "vitest";
import type { CritiqueRun } from "../../../extensions/pr-workflow/critique.js";
import {
	formatCritiqueSummary,
	runCritiqueAction,
} from "../../../extensions/pr-workflow/critique-action.js";
import type {
	CouncilRun,
	Finding,
} from "../../../extensions/pr-workflow/findings.js";
import type { JudgeRun } from "../../../extensions/pr-workflow/judge.js";
import { createPrWorkflowState } from "../../../extensions/pr-workflow/state.js";
import {
	type WorktreeProvider,
	WorktreeRegistry,
} from "../../../extensions/pr-workflow/worktree.js";
import { expectFailure, prMetadata } from "./fixtures.js";

function fakeProvider(): WorktreeProvider {
	return {
		id: "fake",
		async ensure(req) {
			return {
				path: `/wt/${req.sha}`,
				sha: req.sha,
				providerId: "fake",
				reusable: true,
				createdAt: new Date(0),
			};
		},
		async release() {},
	};
}

function consolidated(): Finding {
	return {
		id: 10,
		location: { kind: "global" },
		label: "issue",
		decorations: [],
		subject: "consolidated",
		discussion: "d",
		category: "scope",
		origin: { kind: "judge", runId: "j-1", judgeReviewerId: "j" },
		state: "draft",
		agreement: { raisedBy: ["fast", "skeptic"], sourceFindingIds: [1, 2] },
	};
}

function withFullPipeline() {
	const state = createPrWorkflowState();
	state.pr = {
		reference: { owner: "o", repo: "r", number: 42 },
		loadedAt: "2026-01-01T00:00:00Z",
		metadata: prMetadata({
			title: "t",
			url: "u",
			author: "a",
			base: { ref: "main", sha: "deadbeef" },
			head: { ref: "feat", sha: "headsha1" },
		}),
		files: [],
		stack: null,
	};
	state.council.roster = [
		{ id: "fast", model: "m-fast" },
		{ id: "skeptic", model: "m-skep" },
	];
	const council: CouncilRun = {
		id: "c-1",
		startedAt: "2026-01-01T00:00:00Z",
		target: { kind: "diff", prNumber: 42 },
		reviewerOutputs: [
			{ reviewerId: "fast", findings: [], warnings: [] },
			{ reviewerId: "skeptic", findings: [], warnings: [] },
		],
	};
	const judge: JudgeRun = {
		id: "j-1",
		startedAt: "2026-01-01T00:05:00Z",
		judgeReviewerId: "j",
		selfSignal: { confidence: "high", rationale: "ok" },
		consolidatedFindings: [consolidated()],
		warnings: [],
	};
	state.council.lastRun = council;
	state.council.lastJudge = judge;
	return state;
}

describe("runCritiqueAction", () => {
	it("refuses without a judge run", async () => {
		const state = withFullPipeline();
		state.council.lastJudge = null;
		const result = await runCritiqueAction({
			state,
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch: async () => {
				throw new Error("should not be called");
			},
		});
		expect(expectFailure(result).error).toMatch(/judge|round 2/i);
	});

	it("refuses without a roster", async () => {
		const state = withFullPipeline();
		state.council.roster = [];
		const result = await runCritiqueAction({
			state,
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch: async () => {
				throw new Error("should not be called");
			},
		});
		expect(expectFailure(result).error).toMatch(/roster|reviewer/i);
	});

	it("dispatches each roster member and stores the CritiqueRun in state", async () => {
		const state = withFullPipeline();
		const result = await runCritiqueAction({
			state,
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch: async (opts) => ({
				reviewerId: opts.reviewer.id,
				exitCode: 0,
				finalAssistantText: [
					"```json",
					JSON.stringify({
						critiques: [
							{
								findingId: 10,
								position: opts.reviewer.id === "fast" ? "agree" : "disagree",
								rationale: `${opts.reviewer.id} said so`,
							},
						],
					}),
					"```",
				].join("\n"),
				stderr: "",
				warnings: [],
			}),
		});
		expect(result.ok).toBe(true);
		expect(state.council.lastCritique).not.toBeNull();
		expect(state.council.lastCritique?.reviewerOutputs).toHaveLength(2);
	});
});

describe("formatCritiqueSummary", () => {
	it("groups critiques per consolidated finding with the position counts and reviewer ids", async () => {
		const judge: JudgeRun = {
			id: "j-1",
			startedAt: "2026-01-01T00:05:00Z",
			judgeReviewerId: "j",
			selfSignal: null,
			consolidatedFindings: [consolidated()],
			warnings: [],
		};
		const critique: CritiqueRun = {
			id: "critique-1",
			startedAt: "2026-01-01T00:10:00Z",
			judgeRunId: "j-1",
			reviewerOutputs: [
				{
					reviewerId: "fast",
					critiques: [
						{
							reviewerId: "fast",
							findingId: 10,
							position: "agree",
							rationale: "matches what I saw",
						},
					],
					warnings: [],
				},
				{
					reviewerId: "skeptic",
					critiques: [
						{
							reviewerId: "skeptic",
							findingId: 10,
							position: "disagree",
							rationale: "false positive",
						},
					],
					warnings: [],
				},
			],
			warnings: [],
		};
		const text = formatCritiqueSummary({ judge, critique });
		// Subject of the consolidated finding shows
		expect(text).toContain("consolidated");
		// Both positions and both reviewers
		expect(text).toContain("agree");
		expect(text).toContain("disagree");
		expect(text).toContain("fast");
		expect(text).toContain("skeptic");
		// Rationale present so the user sees the dissent
		expect(text).toContain("false positive");
	});

	it("notes findings with no critique attached", async () => {
		// If a reviewer doesn't take a position on a
		// finding, the summary should flag that so the
		// user sees the gap.
		const judge: JudgeRun = {
			id: "j-1",
			startedAt: "2026-01-01T00:05:00Z",
			judgeReviewerId: "j",
			selfSignal: null,
			consolidatedFindings: [consolidated()],
			warnings: [],
		};
		const critique: CritiqueRun = {
			id: "critique-1",
			startedAt: "2026-01-01T00:10:00Z",
			judgeRunId: "j-1",
			reviewerOutputs: [
				{ reviewerId: "fast", critiques: [], warnings: [] },
				{ reviewerId: "skeptic", critiques: [], warnings: [] },
			],
			warnings: [],
		};
		const text = formatCritiqueSummary({ judge, critique });
		expect(text).toMatch(/no critique|silent|no position/i);
	});
});

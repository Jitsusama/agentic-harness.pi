import { describe, expect, it } from "vitest";
import type { CouncilRun } from "../../../extensions/pr-workflow/findings.js";
import {
	configureJudge,
	formatJudgeSummary,
	runJudgeAction,
} from "../../../extensions/pr-workflow/judge-action.js";
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

function withLoadedPr() {
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
	return state;
}

function withCouncilRun(run: Partial<CouncilRun> = {}): CouncilRun {
	return {
		id: "council-1",
		startedAt: "2026-01-01T00:00:00Z",
		target: { kind: "diff", prNumber: 42 },
		reviewerOutputs: [
			{
				reviewerId: "fast",
				findings: [
					{
						id: 1,
						location: { kind: "global" },
						label: "issue",
						decorations: [],
						subject: "x",
						discussion: "y",
						category: "scope",
						origin: {
							kind: "council",
							runId: "council-1",
							reviewerId: "fast",
						},
						state: "draft",
					},
				],
				warnings: [],
			},
		],
		...run,
	};
}

describe("configureJudge", () => {
	it("sets the judge reviewer in state", async () => {
		const state = createPrWorkflowState();
		const result = configureJudge(state, {
			judge: { id: "j", model: "anthropic/claude-opus-4-7" },
		});
		expect(result.ok).toBe(true);
		expect(state.council.judge).toEqual({
			id: "j",
			model: "anthropic/claude-opus-4-7",
		});
	});

	it("rejects an empty judge id — every finding needs a stamping reviewerId", async () => {
		const state = createPrWorkflowState();
		const result = configureJudge(state, {
			judge: { id: "", model: "x" },
		});
		expect(expectFailure(result).error).toMatch(/judge id|empty|reviewer id/i);
	});

	it("rejects a judge id already used by a council reviewer", async () => {
		const state = createPrWorkflowState();
		state.council.roster = [{ id: "fast", model: "x" }];
		const result = configureJudge(state, {
			judge: { id: "fast", model: "y" },
		});
		expect(expectFailure(result).error).toMatch(/council reviewer|distinct/i);
	});

	it("rejects reusing a locked judge id for a different identity", async () => {
		const state = createPrWorkflowState();
		state.participantIdentities.set("judge", {
			id: "judge",
			role: "judge",
			model: "model-a",
		});
		const result = configureJudge(state, {
			judge: { id: "judge", model: "model-b" },
		});
		expect(expectFailure(result).error).toMatch(/already used|new id/i);
	});

	it("allows reconfiguring a locked judge id with the same identity", async () => {
		const state = createPrWorkflowState();
		state.participantIdentities.set("judge", {
			id: "judge",
			role: "judge",
			model: "model-a",
		});
		const result = configureJudge(state, {
			judge: { id: "judge", model: "model-a" },
		});
		expect(result.ok).toBe(true);
	});
});

describe("runJudgeAction", () => {
	it("refuses to run when no council run is available", async () => {
		const state = withLoadedPr();
		state.council.judge = { id: "j" };
		const result = await runJudgeAction({
			state,
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch: async () => {
				throw new Error("should not be called");
			},
		});
		expect(expectFailure(result).error).toMatch(/council|round 1|fanout/i);
	});

	it("refuses to run when no judge is configured", async () => {
		const state = withLoadedPr();
		state.council.lastRun = withCouncilRun();
		const result = await runJudgeAction({
			state,
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch: async () => {
				throw new Error("should not be called");
			},
		});
		expect(expectFailure(result).error).toMatch(/judge|configure/i);
	});

	it("dispatches the judge, parses output, and stores the JudgeRun in state", async () => {
		const state = withLoadedPr();
		state.council.lastRun = withCouncilRun();
		state.council.judge = { id: "j", model: "anthropic/claude-opus-4-7" };

		const result = await runJudgeAction({
			state,
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch: async () => ({
				reviewerId: "j",
				exitCode: 0,
				finalAssistantText: [
					"```json",
					JSON.stringify({
						selfSignal: { confidence: "medium", rationale: "ok" },
						findings: [
							{
								location: { kind: "global" },
								label: "issue",
								subject: "consolidated",
								discussion: "d",
								raisedBy: ["fast"],
								sourceFindingIds: [1],
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
		expect(state.council.lastJudge).not.toBeNull();
		expect(state.council.lastJudge?.consolidatedFindings).toHaveLength(1);
		expect(state.council.lastJudge?.selfSignal?.confidence).toBe("medium");
		expect(state.participantIdentities.get("j")).toEqual({
			id: "j",
			role: "judge",
			model: "anthropic/claude-opus-4-7",
		});
	});

	it("clears stale decisions and critiques when a new judge run lands", async () => {
		const state = withLoadedPr();
		state.nextFindingId = 2;
		state.council.lastRun = withCouncilRun();
		state.council.judge = { id: "j", model: "anthropic/claude-opus-4-7" };
		state.council.decisions.set(2, {
			findingId: 2,
			verdict: "fix",
			decidedAt: "2026-05-20T15:00:00Z",
			resolvedBy: {
				commitSha: "abc1234",
				recordedAt: "2026-05-20T15:05:00Z",
			},
		});
		state.council.lastCritique = {
			id: "critique-old",
			startedAt: "2026-05-20T15:10:00Z",
			judgeRunId: "judge-old",
			reviewerOutputs: [],
			warnings: [],
		};

		const result = await runJudgeAction({
			state,
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch: async () => ({
				reviewerId: "j",
				exitCode: 0,
				finalAssistantText: [
					"```json",
					JSON.stringify({
						findings: [
							{
								location: { kind: "global" },
								label: "issue",
								subject: "new finding with reused id",
								discussion: "d",
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
		expect(state.council.lastJudge?.consolidatedFindings[0]?.id).toBe(2);
		expect(state.nextFindingId).toBe(3);
		expect(state.council.decisions.size).toBe(0);
		expect(state.council.lastCritique).toBeNull();
	});
});

describe("formatJudgeSummary", () => {
	it("renders the judge's confidence, rationale, and consolidated findings", async () => {
		// User sees this after running the judge. Must
		// include enough to triage — self-signal,
		// finding count, agreement attribution.
		const summary = formatJudgeSummary({
			id: "judge-1",
			startedAt: "2026-01-01T00:00:00Z",
			judgeReviewerId: "j",
			selfSignal: { confidence: "high", rationale: "unanimous on critical" },
			consolidatedFindings: [
				{
					id: 4,
					location: { kind: "global" },
					label: "issue",
					decorations: [],
					subject: "critical bug",
					discussion: "...",
					category: "scope",
					origin: { kind: "judge", runId: "judge-1", judgeReviewerId: "j" },
					state: "draft",
					agreement: {
						raisedBy: ["fast", "skeptic"],
						sourceFindingIds: [1, 3],
					},
				},
			],
			warnings: [],
		});
		expect(summary).toContain("high");
		expect(summary).toContain("unanimous on critical");
		expect(summary).toContain("critical bug");
		expect(summary).toContain("fast");
		expect(summary).toContain("skeptic");
	});

	it("surfaces warnings when present", async () => {
		const summary = formatJudgeSummary({
			id: "judge-1",
			startedAt: "2026-01-01T00:00:00Z",
			judgeReviewerId: "j",
			selfSignal: null,
			consolidatedFindings: [],
			warnings: ["Judge JSON failed to parse: unexpected token"],
		});
		expect(summary).toContain("Judge JSON failed to parse");
	});
});

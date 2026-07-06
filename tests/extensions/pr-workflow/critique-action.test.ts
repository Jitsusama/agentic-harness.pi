import { describe, expect, it } from "vitest";
import type { CritiqueRun } from "../../../extensions/pr-workflow/critique.js";
import {
	formatCritiqueSummary,
	retryCritiqueReviewer,
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
	type WorktreeRequest,
} from "../../../extensions/pr-workflow/worktree.js";
import { expectFailure, prMetadata } from "./fixtures.js";

function fakeProvider(requests?: WorktreeRequest[]): WorktreeProvider {
	return {
		id: "fake",
		async ensure(req) {
			requests?.push(req);
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

function consolidated(overrides: Partial<Finding> = {}): Finding {
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
		...overrides,
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

	it("passes the PR head branch as a worktree hint", async () => {
		const requests: WorktreeRequest[] = [];
		const state = withFullPipeline();
		const result = await runCritiqueAction({
			state,
			registry: new WorktreeRegistry(fakeProvider(requests)),
			dispatch: async (opts) => ({
				reviewerId: opts.reviewer.id,
				exitCode: 0,
				finalAssistantText: JSON.stringify({ critiques: [] }),
				stderr: "",
				warnings: [],
			}),
		});

		expect(result.ok).toBe(true);
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({
			owner: "o",
			repo: "r",
			sha: "headsha1",
			branch: "feat",
		});
	});

	it("critiques stack-review findings across every PR and cross-PR finding", async () => {
		const state = createPrWorkflowState();
		state.pr = {
			reference: { owner: "o", repo: "r", number: 102 },
			loadedAt: "2026-01-01T00:00:00Z",
			metadata: prMetadata({
				title: "PR 102",
				url: "u",
				author: "a",
				base: { ref: "f101", sha: "base" },
				head: { ref: "f102", sha: "headsha2" },
			}),
			files: [],
			stack: {
				cursorIndex: 1,
				cursorChildren: [],
				entries: [
					{
						reference: { owner: "o", repo: "r", number: 101 },
						title: "PR 101",
						baseRefName: "main",
						headRefName: "f101",
					},
					{
						reference: { owner: "o", repo: "r", number: 102 },
						title: "PR 102",
						baseRefName: "f101",
						headRefName: "f102",
					},
				],
			},
		};
		state.council.roster = [{ id: "fast", model: "m-fast" }];
		state.council.lastRun = null;
		state.council.lastJudge = {
			id: "stack-judge-pr-102",
			startedAt: "2026-01-01T00:05:00Z",
			judgeReviewerId: "judge",
			selfSignal: null,
			consolidatedFindings: [
				consolidated({ id: 20, subject: "current PR finding" }),
			],
			warnings: [],
		};
		state.stackRuns.set(101, {
			lastRun: null,
			lastJudge: {
				id: "stack-judge-pr-101",
				startedAt: "2026-01-01T00:05:00Z",
				judgeReviewerId: "judge",
				selfSignal: null,
				consolidatedFindings: [
					consolidated({ id: 10, subject: "upstream PR finding" }),
				],
				warnings: [],
			},
			lastCritique: null,
			decisions: new Map(),
		});
		state.stackFindingRun = {
			id: "stack-judge",
			startedAt: "2026-01-01T00:05:00Z",
			reviewerId: "judge",
			findings: [
				{
					...consolidated({ id: 30, subject: "cross PR finding" }),
					homePrNumber: 102,
					spans: [101, 102],
				},
			],
			warnings: [],
		};

		const result = await runCritiqueAction({
			state,
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch: async (opts) => {
				expect(opts.prompt).toContain("upstream PR finding");
				expect(opts.prompt).toContain("current PR finding");
				expect(opts.prompt).toContain("cross PR finding");
				return {
					reviewerId: opts.reviewer.id,
					exitCode: 0,
					finalAssistantText: JSON.stringify({
						critiques: [10, 20, 30].map((findingId) => ({
							findingId,
							position: "agree",
							rationale: `r-${findingId}`,
						})),
					}),
					stderr: "",
					warnings: [],
				};
			},
			now: () => new Date("2026-01-01T00:10:00Z"),
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.judge.consolidatedFindings.map((f) => f.id)).toEqual([
			10, 20, 30,
		]);
		expect(result.run.id).toBe("stack-critique-2026-01-01T00:10:00.000Z");
		expect(
			result.run.reviewerOutputs[0]?.critiques.map((c) => c.findingId),
		).toEqual([10, 20, 30]);
		expect(state.council.lastCritique).toBe(result.run);
		expect(state.stackRuns.get(101)?.lastCritique).toBe(result.run);
		expect(state.stackFindingRun.critique).toBe(result.run);
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
		// Empty WITHOUT warnings is a legitimate 'nothing
		// to flag' shape; the retry hint should stay quiet.
		expect(text).not.toMatch(/critique-retry/);
	});

	it("surfaces a retry hint for reviewers that came back empty with warnings", async () => {
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
					reviewerId: "skeptic",
					critiques: [],
					warnings: ["Pi subprocess exited non-zero (exit 1)"],
				},
			],
			warnings: [],
		};
		const text = formatCritiqueSummary({ judge, critique });
		expect(text).toMatch(/critique-retry reviewerId=skeptic/);
	});

	it("swaps the per-reviewer retry hint for a session-level advisory when the runtime is stale", async () => {
		// When pi was updated mid-session, every reviewer
		// fails with the same `ENOENT` on a path inside
		// `.pi/pkg/pi-X.Y.Z/`. Suggesting `critique-retry`
		// for each one is misleading — no retry will succeed
		// until pi is restarted. Replace the hint with a
		// single "restart pi" advisory at the top.
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
					reviewerId: "opus",
					critiques: [],
					warnings: [
						"Pi subprocess exited non-zero (exit 1)",
						"Pi runtime stale: subagent crashed loading `/Users/x/.pi/pkg/pi-0.75.3/package.json`, which no longer exists. Restart pi to recover.",
					],
				},
				{
					reviewerId: "gpt",
					critiques: [],
					warnings: [
						"Pi subprocess exited non-zero (exit 1)",
						"Pi runtime stale: subagent crashed loading `/Users/x/.pi/pkg/pi-0.75.3/package.json`, which no longer exists. Restart pi to recover.",
					],
				},
			],
			warnings: [],
		};
		const text = formatCritiqueSummary({ judge, critique });
		expect(text).toMatch(/Pi runtime stale/);
		expect(text).toMatch(/restart pi/i);
		expect(text).not.toMatch(/critique-retry/);
	});
});

describe("retryCritiqueReviewer", () => {
	it("refuses without a PR loaded", async () => {
		const state = createPrWorkflowState();
		const result = await retryCritiqueReviewer({
			state,
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch: async () => {
				throw new Error("should not be called");
			},
			reviewerId: "fast",
		});
		expect(expectFailure(result).error).toMatch(/PR is not fully loaded/i);
	});

	it("refuses without a critique run to retry", async () => {
		const state = withFullPipeline();
		state.council.lastCritique = null;
		const result = await retryCritiqueReviewer({
			state,
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch: async () => {
				throw new Error("should not be called");
			},
			reviewerId: "fast",
		});
		expect(expectFailure(result).error).toMatch(
			/no critique run|critique first/i,
		);
	});

	it("refuses when the reviewerId is not in the roster", async () => {
		const state = withFullPipeline();
		state.council.lastCritique = {
			id: "critique-1",
			startedAt: "2026-01-01T00:10:00Z",
			judgeRunId: "j-1",
			reviewerOutputs: [{ reviewerId: "fast", critiques: [], warnings: [] }],
			warnings: [],
		};
		const result = await retryCritiqueReviewer({
			state,
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch: async () => {
				throw new Error("should not be called");
			},
			reviewerId: "ghost",
		});
		expect(expectFailure(result).error).toMatch(/ghost.*not in/i);
	});

	it("refuses when the reviewer has no prior critique output to replace", async () => {
		const state = withFullPipeline();
		state.council.lastCritique = {
			id: "critique-1",
			startedAt: "2026-01-01T00:10:00Z",
			judgeRunId: "j-1",
			reviewerOutputs: [{ reviewerId: "fast", critiques: [], warnings: [] }],
			warnings: [],
		};
		const result = await retryCritiqueReviewer({
			state,
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch: async () => {
				throw new Error("should not be called");
			},
			reviewerId: "skeptic",
		});
		expect(expectFailure(result).error).toMatch(
			/skeptic.*no output|last critique run/i,
		);
	});

	it("substitutes the reviewer's critique output in place", async () => {
		// Pre-existing: fast disagreed, skeptic crashed.
		// Retry skeptic; their fresh "agree" position
		// should overwrite the empty/warned-out entry while
		// fast's disagree stays put.
		const state = withFullPipeline();
		state.council.lastCritique = {
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
							position: "disagree",
							rationale: "not buying it",
						},
					],
					warnings: [],
				},
				{
					reviewerId: "skeptic",
					critiques: [],
					warnings: ["crashed earlier"],
				},
			],
			warnings: [],
		};
		const result = await retryCritiqueReviewer({
			state,
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch: async (opts) => ({
				reviewerId: opts.reviewer.id,
				exitCode: 0,
				finalAssistantText: JSON.stringify({
					critiques: [
						{
							findingId: 10,
							position: "agree",
							rationale: "on reflection, yes",
						},
					],
				}),
				stderr: "",
				warnings: [],
			}),
			reviewerId: "skeptic",
		});
		expect(result.ok).toBe(true);
		const run = state.council.lastCritique as CritiqueRun;
		expect(run.reviewerOutputs).toHaveLength(2);
		const skeptic = run.reviewerOutputs.find((o) => o.reviewerId === "skeptic");
		const fast = run.reviewerOutputs.find((o) => o.reviewerId === "fast");
		expect(skeptic?.critiques).toHaveLength(1);
		expect(skeptic?.critiques[0].position).toBe("agree");
		expect(skeptic?.warnings).toEqual([]);
		// fast's pre-existing critique untouched.
		expect(fast?.critiques[0].position).toBe("disagree");
	});

	it("drives the progress panel so a critique retry is visible and cancellable", async () => {
		const state = withFullPipeline();
		state.council.lastCritique = {
			id: "critique-1",
			startedAt: "2026-01-01T00:10:00Z",
			judgeRunId: "j-1",
			reviewerOutputs: [{ reviewerId: "skeptic", critiques: [], warnings: [] }],
			warnings: [],
		};
		const events: string[] = [];
		const progress = {
			start: () => events.push("start"),
			reviewerStarted: () => events.push("started"),
			reviewerActivity: () => events.push("activity"),
			reviewerCompleted: () => events.push("completed"),
			reviewerCancelled: () => events.push("cancelled"),
			reviewerFailed: () => events.push("failed"),
			finish: () => events.push("finish"),
		};
		const result = await retryCritiqueReviewer({
			state,
			registry: new WorktreeRegistry(fakeProvider()),
			progress,
			dispatch: async (opts) => ({
				reviewerId: opts.reviewer.id,
				exitCode: 0,
				finalAssistantText: JSON.stringify({ critiques: [] }),
				stderr: "",
				warnings: [],
			}),
			reviewerId: "skeptic",
		});
		expect(result.ok).toBe(true);
		expect(events).toContain("start");
		expect(events).toContain("started");
		expect(events).toContain("completed");
	});
});

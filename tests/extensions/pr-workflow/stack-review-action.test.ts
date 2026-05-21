/** Tests for the stack-wide review runtime action. */

import { describe, expect, it } from "vitest";
import type { CouncilDispatch } from "../../../extensions/pr-workflow/council.js";
import type { CouncilProgress } from "../../../extensions/pr-workflow/council-progress.js";
import type { CouncilReviewer } from "../../../extensions/pr-workflow/reviewer.js";
import type { Stack } from "../../../extensions/pr-workflow/stack.js";
import {
	formatStackReviewActionSummary,
	runStackReviewAction,
} from "../../../extensions/pr-workflow/stack-review-action.js";
import {
	createPrWorkflowState,
	type PrWorkflowState,
} from "../../../extensions/pr-workflow/state.js";
import { WorktreeRegistry } from "../../../extensions/pr-workflow/worktree.js";
import { fakeProvider } from "./council.test-helpers.js";
import { expectFailure, prMetadata } from "./fixtures.js";

function reviewer(id: string): CouncilReviewer {
	return { id, model: "anthropic/claude-haiku-4-5" };
}

function buildState(stackNumbers: number[] = [101, 102]): PrWorkflowState {
	const cursor = stackNumbers[0] ?? 101;
	const state = createPrWorkflowState();
	state.council.roster = [reviewer("fast"), reviewer("skeptic")];
	state.council.judge = reviewer("judge");
	const entries: Stack["entries"] = stackNumbers.map((number) => ({
		reference: { owner: "o", repo: "r", number },
		title: `PR ${number}`,
		baseRefName: "main",
		headRefName: `f${number}`,
	}));
	state.pr = {
		reference: { owner: "o", repo: "r", number: cursor },
		loadedAt: "2026-05-20T16:00:00Z",
		metadata: prMetadata({
			title: `PR ${cursor}`,
			body: `Body ${cursor}`,
			head: { ref: `f${cursor}`, sha: `sha-${cursor}` },
		}),
		files: [],
		stack:
			stackNumbers.length > 1
				? { entries, cursorIndex: 0, cursorChildren: [] }
				: null,
	};
	return state;
}

function fetchers() {
	return {
		metadata: async (ref: { number: number }) =>
			prMetadata({
				title: `PR ${ref.number}`,
				body: `Body ${ref.number}`,
				head: { ref: `f${ref.number}`, sha: `sha-${ref.number}` },
			}),
		diff: async () => [],
	};
}

function jsonBlock(value: unknown): string {
	return ["```json", JSON.stringify(value), "```"].join("\n");
}

function progressRecorder(events: string[]): CouncilProgress {
	return {
		start(entries) {
			events.push(`start:${entries.map((e) => e.reviewer.id).join(",")}`);
		},
		reviewerStarted(reviewerId) {
			events.push(`started:${reviewerId}`);
		},
		reviewerActivity(reviewerId, activity) {
			events.push(`activity:${reviewerId}:${activity}`);
		},
		reviewerCompleted(reviewerId, output) {
			events.push(`completed:${reviewerId}:${output.findings.length}`);
		},
		reviewerFailed(reviewerId, error) {
			events.push(`failed:${reviewerId}:${error}`);
		},
		finish() {
			events.push("finish");
		},
	};
}

function dispatch(): CouncilDispatch {
	return async ({ reviewer: r, prompt, cwd }) => {
		if (r.id === "judge") {
			expect(prompt).toContain('stage: "stack-judge"');
			expect(cwd).toContain("sha-102");
			return {
				reviewerId: r.id,
				exitCode: 0,
				finalAssistantText: jsonBlock({
					selfSignal: { confidence: "high", rationale: "clean" },
					perPr: {
						"101": [
							{
								location: { kind: "global" },
								label: "issue",
								subject: "cursor issue",
								discussion: "cursor details",
								raisedBy: ["fast"],
								sourceFindingIds: [1],
							},
						],
						"102": [
							{
								location: { kind: "global" },
								label: "suggestion",
								subject: "stack mate issue",
								discussion: "mate details",
							},
						],
					},
					crossPr: [
						{
							location: { kind: "global" },
							label: "issue",
							subject: "cross issue",
							discussion: "cross details",
							homePrNumber: 101,
							spans: [101, 102],
							raisedBy: ["fast", "skeptic"],
							sourceFindingIds: [3, 4],
						},
					],
				}),
				stderr: "",
				warnings: [],
			};
		}
		expect(prompt).toContain('stage: "stack-review"');
		expect(prompt).toContain("### PR #101 [cursor]: PR 101");
		expect(prompt).toContain("### PR #102: PR 102");
		return {
			reviewerId: r.id,
			exitCode: 0,
			finalAssistantText: jsonBlock({
				perPr: {
					"101": [
						{
							location: { kind: "global" },
							label: "issue",
							subject: `round one ${r.id}`,
							discussion: "d",
						},
					],
					"102": [],
				},
				crossPr: [],
			}),
			stderr: "",
			warnings: [],
		};
	};
}

describe("runStackReviewAction guards", () => {
	it("refuses without a loaded PR", async () => {
		const result = await runStackReviewAction({
			state: createPrWorkflowState(),
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch: dispatch(),
			fetchers: fetchers(),
		});
		expect(expectFailure(result).error).toMatch(/No PR is loaded/);
	});

	it("refuses without a roster", async () => {
		const state = buildState();
		state.council.roster = [];
		const result = await runStackReviewAction({
			state,
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch: dispatch(),
			fetchers: fetchers(),
		});
		expect(expectFailure(result).error).toMatch(/roster is empty/);
	});

	it("refuses without a judge", async () => {
		const state = buildState();
		state.council.judge = null;
		const result = await runStackReviewAction({
			state,
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch: dispatch(),
			fetchers: fetchers(),
		});
		expect(expectFailure(result).error).toMatch(/Judge not configured/);
	});
});

describe("runStackReviewAction", () => {
	it("runs stack-wide reviewers and writes per-PR plus cross-PR findings", async () => {
		const state = buildState();
		state.nextFindingId = 20;
		const result = await runStackReviewAction({
			state,
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch: dispatch(),
			fetchers: fetchers(),
			now: () => new Date("2026-05-20T16:00:00Z"),
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.run.reviewedPrs).toEqual([
			{ prNumber: 101, findingCount: 1 },
			{ prNumber: 102, findingCount: 1 },
		]);
		expect(result.run.crossPrFindingCount).toBe(1);
		expect(state.council.lastJudge?.selfSignal?.confidence).toBe("high");
		expect(state.council.lastJudge?.consolidatedFindings[0]?.id).toBe(22);
		expect(state.council.lastJudge?.consolidatedFindings[0]?.subject).toBe(
			"cursor issue",
		);
		expect(state.council.lastJudge?.consolidatedFindings[0]?.origin.kind).toBe(
			"stack-judge",
		);
		expect(
			state.stackRuns.get(102)?.lastJudge?.consolidatedFindings[0]?.id,
		).toBe(23);
		expect(
			state.stackRuns.get(102)?.lastJudge?.consolidatedFindings[0]?.subject,
		).toBe("stack mate issue");
		expect(state.stackFindingRun?.findings[0]?.id).toBe(24);
		expect(state.stackFindingRun?.findings[0]?.subject).toBe("cross issue");
		expect(state.stackFindingRun?.findings[0]?.homePrNumber).toBe(101);
		expect(state.nextFindingId).toBe(25);
		expect(state.participantIdentities.get("fast")).toEqual({
			id: "fast",
			role: "reviewer",
			model: "anthropic/claude-haiku-4-5",
		});
		expect(state.participantIdentities.get("judge")).toEqual({
			id: "judge",
			role: "judge",
			model: "anthropic/claude-haiku-4-5",
		});
	});

	it("clears decisions when stack review replaces visible findings", async () => {
		const state = buildState();
		state.council.decisions.set(3, {
			findingId: 3,
			verdict: "fix",
			decidedAt: "2026-05-20T15:00:00Z",
			resolvedBy: {
				commitSha: "abc1234",
				recordedAt: "2026-05-20T15:05:00Z",
			},
		});
		state.stackRuns.set(102, {
			lastRun: null,
			lastJudge: null,
			lastCritique: null,
			decisions: new Map([
				[4, { findingId: 4, verdict: "endorse", decidedAt: "old" }],
			]),
		});
		state.stackDecisions.set(5, {
			findingId: 5,
			verdict: "dismiss",
			decidedAt: "old",
			reason: "stale",
		});

		const result = await runStackReviewAction({
			state,
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch: dispatch(),
			fetchers: fetchers(),
			now: () => new Date("2026-05-20T16:00:00Z"),
		});

		expect(result.ok).toBe(true);
		expect(state.council.lastJudge?.consolidatedFindings[0]?.id).toBe(3);
		expect(state.council.decisions.size).toBe(0);
		expect(
			state.stackRuns.get(102)?.lastJudge?.consolidatedFindings[0]?.id,
		).toBe(4);
		expect(state.stackRuns.get(102)?.decisions.size).toBe(0);
		expect(state.stackFindingRun?.findings[0]?.id).toBe(5);
		expect(state.stackDecisions.size).toBe(0);
	});

	it("reports reviewer, activity and judge progress", async () => {
		const state = buildState();
		const events: string[] = [];
		const result = await runStackReviewAction({
			state,
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch: async ({ reviewer: r, onEvent }) => {
				onEvent?.({
					type: "tool_execution_start",
					toolName: "read",
					args: { path: "task.go" },
				});
				if (r.id === "judge") {
					return {
						reviewerId: r.id,
						exitCode: 0,
						finalAssistantText: jsonBlock({
							perPr: { "101": [], "102": [] },
							crossPr: [],
						}),
						stderr: "",
						warnings: [],
					};
				}
				return {
					reviewerId: r.id,
					exitCode: 0,
					finalAssistantText: jsonBlock({
						perPr: {
							"101": [
								{
									location: { kind: "global" },
									label: "issue",
									subject: `issue ${r.id}`,
									discussion: "d",
								},
							],
							"102": [],
						},
						crossPr: [],
					}),
					stderr: "",
					warnings: [],
				};
			},
			fetchers: fetchers(),
			progress: progressRecorder(events),
		});

		expect(result.ok).toBe(true);
		expect(events).toEqual([
			"start:fast,skeptic,judge",
			"started:fast",
			"activity:fast:reading task.go",
			"started:skeptic",
			"activity:skeptic:reading task.go",
			"completed:fast:1",
			"completed:skeptic:1",
			"started:judge",
			"activity:judge:reading task.go",
			"completed:judge:0",
			"finish",
		]);
	});

	it("degenerates to a single-PR stack when no stack is loaded", async () => {
		const state = buildState([101]);
		const result = await runStackReviewAction({
			state,
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch: async ({ reviewer: r }) => {
				if (r.id === "judge") {
					return {
						reviewerId: r.id,
						exitCode: 0,
						finalAssistantText: jsonBlock({
							perPr: { "101": [] },
							crossPr: [],
						}),
						stderr: "",
						warnings: [],
					};
				}
				return {
					reviewerId: r.id,
					exitCode: 0,
					finalAssistantText: jsonBlock({ perPr: { "101": [] }, crossPr: [] }),
					stderr: "",
					warnings: [],
				};
			},
			fetchers: fetchers(),
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.run.reviewedPrs).toEqual([
			{ prNumber: 101, findingCount: 0 },
		]);
		expect(state.stackRuns.size).toBe(0);
	});
});

describe("formatStackReviewActionSummary", () => {
	it("renders cursor marker, cross-PR count and warnings", () => {
		const text = formatStackReviewActionSummary({
			id: "stack-review-1",
			startedAt: "2026-05-20T16:00:00Z",
			cursorPrNumber: 101,
			reviewedPrs: [
				{ prNumber: 101, findingCount: 1 },
				{ prNumber: 102, findingCount: 0 },
			],
			crossPrFindingCount: 2,
			reviewerOutputs: [],
			warnings: ["fast: skipped malformed finding"],
		});
		expect(text).toContain("Stack review stack-review-1");
		expect(text).toContain("cross-PR findings: 2");
		expect(text).toContain("▶ PR #101: 1 finding");
		expect(text).toContain("PR #102: 0 findings");
		expect(text).toContain(
			"action=stack-next / action=stack-prev returns the next PR ref",
		);
		expect(text).toContain("fast: skipped malformed finding");
	});
});

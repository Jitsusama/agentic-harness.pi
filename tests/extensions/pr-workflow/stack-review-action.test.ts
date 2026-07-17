/** Tests for the stack-wide review runtime action. */

import { describe, expect, it } from "vitest";
import { ReviewerCancelledError } from "../../../extensions/pr-workflow/cancellation.js";
import type { CouncilDispatch } from "../../../extensions/pr-workflow/council.js";
import type { CouncilProgress } from "../../../extensions/pr-workflow/council-progress.js";
import type { Stack } from "../../../extensions/pr-workflow/stack.js";
import {
	formatStackReviewActionSummary,
	runStackReviewAction,
} from "../../../extensions/pr-workflow/stack-review-action.js";
import {
	createPrWorkflowState,
	type PrWorkflowState,
} from "../../../extensions/pr-workflow/state.js";
import type { ReviewThread } from "../../../extensions/pr-workflow/threads.js";
import {
	type WorktreeProvider,
	WorktreeRegistry,
	type WorktreeRequest,
} from "../../../extensions/pr-workflow/worktree.js";
import type {
	CouncilReviewer,
	RunReviewerResult,
} from "../../../lib/subagent/subagent.js";
import { fakeProvider } from "./council.test-helpers.js";
import { expectFailure, prMetadata } from "./fixtures.js";

function reviewer(id: string): CouncilReviewer {
	return { id, model: "anthropic/claude-haiku-4-5" };
}

function recordingProvider(requests: WorktreeRequest[]): WorktreeProvider {
	return {
		id: "recording",
		async ensure(req) {
			requests.push(req);
			return {
				path: `/wt/${req.sha}`,
				sha: req.sha,
				providerId: "recording",
				reusable: true,
				createdAt: new Date(0),
			};
		},
		async release() {},
	};
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

function reviewThread(prNumber: number): ReviewThread {
	return {
		id: `thread-${prNumber}`,
		kind: "review-thread",
		isResolved: false,
		isOutdated: false,
		path: "src/example.ts",
		line: 10,
		comments: [
			{
				id: `comment-${prNumber}`,
				author: "reviewer",
				body: `thread body ${prNumber}`,
				createdAt: "2026-01-01T00:00:00Z",
				url: `https://example.test/${prNumber}`,
			},
		],
	};
}

function jsonBlock(value: unknown): string {
	return ["```json", JSON.stringify(value), "```"].join("\n");
}

function deferred<T>(): {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(reason: unknown): void;
} {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
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
			events.push(`completed:${reviewerId}:${output.findings?.length ?? 0}`);
		},
		reviewerCancelled(reviewerId) {
			events.push(`cancelled:${reviewerId}`);
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
			expect(prompt).toContain("pr-workflow-stack-judge-output");
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
		expect(prompt).toContain("pr-workflow-stack-review-output");
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

	it("refuses without a roster when config cannot supply one", async () => {
		const state = buildState();
		state.council.roster = [];
		const result = await runStackReviewAction({
			state,
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch: dispatch(),
			fetchers: fetchers(),
			loadConfig: async () => ({
				ok: true,
				config: { path: "/cfg.json", defaults: {} },
			}),
		});
		expect(expectFailure(result).error).toMatch(
			/roster is empty|council-config/i,
		);
	});

	it("refuses without a judge when config cannot supply one", async () => {
		const state = buildState();
		state.council.judge = null;
		const result = await runStackReviewAction({
			state,
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch: dispatch(),
			fetchers: fetchers(),
			loadConfig: async () => ({
				ok: true,
				config: { path: "/cfg.json", defaults: {} },
			}),
		});
		expect(expectFailure(result).error).toMatch(/judge-config/i);
	});

	it("finishes the progress panel even when worktree provisioning throws", async () => {
		// The panel captures the editor on start; a throw
		// from registry.ensure must still finish it or the
		// user loses the keyboard. Regression for the
		// stack-review teardown leak.
		const state = buildState();
		const events: string[] = [];
		const throwingProvider: WorktreeProvider = {
			id: "throwing",
			async ensure() {
				throw new Error("worktree not ready");
			},
			async release() {},
		};
		await expect(
			runStackReviewAction({
				state,
				registry: new WorktreeRegistry(throwingProvider),
				dispatch: dispatch(),
				fetchers: fetchers(),
				progress: progressRecorder(events),
			}),
		).rejects.toThrow("worktree not ready");
		expect(events).toContain("finish");
	});
});

describe("runStackReviewAction", () => {
	it("reuses a verified reviewer on a re-run and only re-runs the unverified one", async () => {
		// A dropped or unverified stack reviewer should be the
		// only one that pays to re-run; a reviewer whose
		// verified result is cached for the identical stack
		// prompt is reused, so recovering does not re-run the
		// whole fan-out.
		const calls: Record<string, number> = {};
		const reviewerBody = jsonBlock({
			perPr: {
				"101": [
					{
						location: { kind: "global" },
						label: "issue",
						subject: "round one",
						discussion: "d",
					},
				],
				"102": [],
			},
			crossPr: [],
		});
		const disp: CouncilDispatch = async ({ reviewer: r }) => {
			calls[r.id] = (calls[r.id] ?? 0) + 1;
			if (r.id === "judge") {
				return {
					reviewerId: r.id,
					exitCode: 0,
					finalAssistantText: jsonBlock({
						selfSignal: { confidence: "high", rationale: "clean" },
						perPr: { "101": [], "102": [] },
						crossPr: [],
					}),
					stderr: "",
					warnings: [],
				};
			}
			// `fast` verifies and is cacheable; `skeptic` never
			// verifies, so it must re-run every time.
			const verified = r.id === "fast";
			return {
				reviewerId: r.id,
				exitCode: 0,
				finalAssistantText: reviewerBody,
				stderr: "",
				warnings: [],
				...(verified ? { verification: { ok: true, called: true } } : {}),
			};
		};
		const state = buildState();
		const registry = new WorktreeRegistry(fakeProvider());
		const first = await runStackReviewAction({
			state,
			registry,
			dispatch: disp,
			fetchers: fetchers(),
		});
		expect(first.ok).toBe(true);
		const second = await runStackReviewAction({
			state,
			registry,
			dispatch: disp,
			fetchers: fetchers(),
		});
		expect(second.ok).toBe(true);
		expect(calls.fast).toBe(1);
		expect(calls.skeptic).toBe(2);
	});

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

	it("passes existing review threads into stack review prompts", async () => {
		const state = buildState([101, 102]);
		const seenPrompts: string[] = [];
		const result = await runStackReviewAction({
			state,
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch: async ({ reviewer: r, prompt }) => {
				seenPrompts.push(prompt);
				return dispatch()({
					reviewer: r,
					prompt,
					cwd: "/wt/sha-102",
					runId: "test",
				});
			},
			fetchers: fetchers(),
			fetchThreads: async (ref) => [reviewThread(ref.number)],
		});

		expect(result.ok).toBe(true);
		expect(
			seenPrompts.some((prompt) => prompt.includes("[T1] src/example.ts:10")),
		).toBe(true);
		expect(
			seenPrompts.some((prompt) => prompt.includes("thread body 102")),
		).toBe(true);
	});

	it("passes the stack tip branch as a worktree hint", async () => {
		const requests: WorktreeRequest[] = [];
		const state = buildState([101, 102]);
		const result = await runStackReviewAction({
			state,
			registry: new WorktreeRegistry(recordingProvider(requests)),
			dispatch: dispatch(),
			fetchers: fetchers(),
		});

		expect(result.ok).toBe(true);
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({
			owner: "o",
			repo: "r",
			sha: "sha-102",
			branch: "f102",
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

	it("reports a stack reviewer as complete as soon as that dispatch settles", async () => {
		const state = buildState();
		const events: string[] = [];
		const fast = deferred<RunReviewerResult>();
		const skeptic = deferred<RunReviewerResult>();
		const judge = deferred<RunReviewerResult>();
		const result = runStackReviewAction({
			state,
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch: ({ reviewer: r }) => {
				if (r.id === "fast") return fast.promise;
				if (r.id === "skeptic") return skeptic.promise;
				return judge.promise;
			},
			fetchers: fetchers(),
			progress: progressRecorder(events),
		});

		for (let i = 0; i < 20 && !events.includes("started:fast"); i++) {
			await Promise.resolve();
		}

		fast.resolve({
			reviewerId: "fast",
			exitCode: 0,
			finalAssistantText: jsonBlock({
				perPr: { "101": [], "102": [] },
				crossPr: [],
			}),
			stderr: "",
			warnings: [],
		});
		for (let i = 0; i < 20 && !events.includes("completed:fast:0"); i++) {
			await Promise.resolve();
		}

		expect(events).toContain("completed:fast:0");
		expect(events).not.toContain("started:judge");
		expect(events).not.toContain("finish");

		skeptic.resolve({
			reviewerId: "skeptic",
			exitCode: 0,
			finalAssistantText: jsonBlock({
				perPr: { "101": [], "102": [] },
				crossPr: [],
			}),
			stderr: "",
			warnings: [],
		});
		for (let i = 0; i < 20 && !events.includes("started:judge"); i++) {
			await Promise.resolve();
		}

		judge.resolve({
			reviewerId: "judge",
			exitCode: 0,
			finalAssistantText: jsonBlock({
				perPr: { "101": [], "102": [] },
				crossPr: [],
			}),
			stderr: "",
			warnings: [],
		});
		expect((await result).ok).toBe(true);
	});

	it("returns a clear error when the stack judge is cancelled", async () => {
		const state = buildState();
		const events: string[] = [];
		const result = await runStackReviewAction({
			state,
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch: async ({ reviewer: r }) => {
				if (r.id === "judge") throw new ReviewerCancelledError(r.id);
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
			},
			fetchers: fetchers(),
			progress: progressRecorder(events),
		});

		expect(expectFailure(result).error).toContain("Stack review cancelled");
		expect(events).toContain("cancelled:judge");
		expect(events).toContain("finish");
		expect(state.council.lastJudge).toBeNull();
	});

	it("preserves completed reviewer output for the cursor PR when judge is cancelled", async () => {
		// The biggest cost of stack-review is the council
		// fan-out. When the judge phase gets cancelled the
		// reviewer work shouldn't be thrown away — the user
		// can call action=judge against the preserved
		// council output to finish the round.
		const state = buildState();
		const result = await runStackReviewAction({
			state,
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch: async ({ reviewer: r }) => {
				if (r.id === "judge") throw new ReviewerCancelledError(r.id);
				return {
					reviewerId: r.id,
					exitCode: 0,
					finalAssistantText: jsonBlock({
						perPr: {
							"101": [
								{
									location: { kind: "global" },
									label: "issue",
									subject: `cursor ${r.id}`,
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
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toMatch(/council.*preserved/i);
			expect(result.error).toContain("action=judge");
		}
		expect(state.council.lastRun).not.toBeNull();
		expect(state.council.lastRun?.reviewerOutputs).toHaveLength(2);
		const reviewerIds =
			state.council.lastRun?.reviewerOutputs.map((o) => o.reviewerId) ?? [];
		expect(reviewerIds).toEqual(["fast", "skeptic"]);
		const fastFindings =
			state.council.lastRun?.reviewerOutputs.find(
				(o) => o.reviewerId === "fast",
			)?.findings ?? [];
		expect(fastFindings).toHaveLength(1);
		expect(fastFindings[0].subject).toBe("cursor fast");
		expect(state.stackFindingRun).toBeNull();
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

	it("surfaces per-reviewer verify_output failures with their message", () => {
		const text = formatStackReviewActionSummary({
			id: "stack-review-1",
			startedAt: "2026-05-20T16:00:00Z",
			cursorPrNumber: 101,
			reviewedPrs: [{ prNumber: 101, findingCount: 0 }],
			crossPrFindingCount: 0,
			reviewerOutputs: [
				{
					reviewerId: "opus",
					perPr: new Map(),
					crossPr: [],
					warnings: [],
					verification: { called: true, ok: true, count: 0 },
				},
				{
					reviewerId: "grok",
					perPr: new Map(),
					crossPr: [],
					warnings: [],
					verification: {
						called: true,
						ok: false,
						message:
							"ok: false. 8 errors against stage=stack-review:\n  /perPr/769188/0/severity: must be equal to constant",
					},
				},
				{
					reviewerId: "gpt",
					perPr: new Map(),
					crossPr: [],
					warnings: [],
					verification: { called: false, ok: false },
				},
			],
			warnings: [],
		});

		expect(text).toContain("opus — verified ✓");
		expect(text).toContain("grok — verification failed");
		expect(text).toContain("verify_output failed");
		expect(text).toContain("8 errors against stage=stack-review");
		expect(text).toContain("gpt — not verified");
		expect(text).toContain("verify_output not called");
	});
});

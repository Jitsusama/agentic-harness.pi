/**
 * Tests for the multi-PR judge fan-out action.
 *
 * `judge-all` consumes the per-PR council runs created
 * by `council-all` and stores judge runs in the same
 * cursor/snapshot slots the rest of the workflow already
 * understands.
 */

import { describe, expect, it } from "vitest";
import type { CouncilDispatch } from "../../../extensions/pr-workflow/council.js";
import type {
	CouncilRun,
	Finding,
} from "../../../extensions/pr-workflow/findings.js";
import {
	formatJudgeAllSummary,
	runJudgeAllAction,
} from "../../../extensions/pr-workflow/judge-all-action.js";
import type { CouncilReviewer } from "../../../extensions/pr-workflow/reviewer.js";
import type { Stack } from "../../../extensions/pr-workflow/stack.js";
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

function finding(id: number, subject = `finding ${id}`): Finding {
	return {
		id,
		location: { kind: "global" },
		label: "issue",
		decorations: [],
		subject,
		discussion: "details",
		category: "scope",
		origin: { kind: "council", runId: "council", reviewerId: "fast" },
		state: "draft",
	};
}

function councilRun(prNumber: number): CouncilRun {
	return {
		id: `council-${prNumber}`,
		startedAt: "2026-05-20T14:00:00Z",
		target: { kind: "diff", prNumber },
		reviewerOutputs: [
			{
				reviewerId: "fast",
				findings: [finding(1, `issue on ${prNumber}`)],
				warnings: [],
			},
		],
	};
}

function buildState(
	stackNumbers: number[],
	cursor: number = stackNumbers[0] ?? 1,
): PrWorkflowState {
	const state = createPrWorkflowState();
	state.council.roster = [reviewer("fast")];
	state.council.judge = reviewer("judge");
	state.active = true;
	const entries: Stack["entries"] = stackNumbers.map((number) => ({
		reference: { owner: "o", repo: "r", number },
		title: `PR ${number}`,
		baseRefName: "main",
		headRefName: `f${number}`,
	}));
	state.pr = {
		reference: { owner: "o", repo: "r", number: cursor },
		loadedAt: "2026-05-20T14:00:00Z",
		metadata: prMetadata({
			title: `PR ${cursor}`,
			head: { ref: `f${cursor}`, sha: `sha-${cursor}` },
		}),
		files: [],
		stack: {
			entries,
			cursorIndex: Math.max(0, stackNumbers.indexOf(cursor)),
			cursorChildren: [],
		},
	};
	return state;
}

function fetchers() {
	return {
		metadata: async (ref: { number: number }) =>
			prMetadata({
				title: `PR ${ref.number}`,
				head: { ref: `f${ref.number}`, sha: `sha-${ref.number}` },
			}),
	};
}

function judgeJson(subject: string) {
	return [
		"```json",
		JSON.stringify({
			selfSignal: { confidence: "medium", rationale: "ok" },
			findings: [
				{
					location: { kind: "global" },
					label: "issue",
					subject,
					discussion: "d",
					raisedBy: ["fast"],
					sourceFindingIds: [1],
				},
			],
		}),
		"```",
	].join("\n");
}

describe("runJudgeAllAction guards", () => {
	it("refuses when no PR is loaded", async () => {
		const result = await runJudgeAllAction({
			state: createPrWorkflowState(),
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch: async () => {
				throw new Error("not called");
			},
			fetchers: fetchers(),
		});
		expect(expectFailure(result).error).toMatch(/No PR is loaded/);
	});

	it("refuses when no judge has been configured", async () => {
		const state = buildState([1, 2]);
		state.council.judge = null;
		const result = await runJudgeAllAction({
			state,
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch: async () => {
				throw new Error("not called");
			},
			fetchers: fetchers(),
		});
		expect(expectFailure(result).error).toMatch(/Judge not configured/);
	});

	it("refuses when the loaded PR has no stack-mates", async () => {
		const state = buildState([1]);
		const result = await runJudgeAllAction({
			state,
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch: async () => {
				throw new Error("not called");
			},
			fetchers: fetchers(),
		});
		expect(expectFailure(result).error).toMatch(/multi-PR stack/);
	});
});

describe("runJudgeAllAction", () => {
	it("judges every PR with a council run and stashes results", async () => {
		const state = buildState([1, 2, 3], 2);
		state.council.lastRun = councilRun(2);
		state.stackRuns.set(1, {
			lastRun: councilRun(1),
			lastJudge: null,
			lastCritique: null,
			decisions: new Map(),
		});
		state.stackRuns.set(3, {
			lastRun: councilRun(3),
			lastJudge: null,
			lastCritique: null,
			decisions: new Map(),
		});

		const seenCwds: string[] = [];
		const dispatch: CouncilDispatch = async ({ cwd, reviewer: r }) => {
			seenCwds.push(cwd);
			return {
				reviewerId: r.id,
				exitCode: 0,
				finalAssistantText: judgeJson(`judged ${extractShaNumber(cwd)}`),
				stderr: "",
				warnings: [],
			};
		};

		const result = await runJudgeAllAction({
			state,
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch,
			fetchers: fetchers(),
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.run.entries.map((e) => e.prNumber)).toEqual([1, 2, 3]);
		expect(result.run.entries.every((e) => e.run !== null)).toBe(true);
		expect(state.council.lastJudge?.consolidatedFindings[0]?.subject).toBe(
			"judged 2",
		);
		expect(
			state.stackRuns.get(1)?.lastJudge?.consolidatedFindings[0]?.subject,
		).toBe("judged 1");
		expect(
			state.stackRuns.get(3)?.lastJudge?.consolidatedFindings[0]?.subject,
		).toBe("judged 3");
		expect(seenCwds).toEqual(
			expect.arrayContaining(["/wt/sha-1", "/wt/sha-2", "/wt/sha-3"]),
		);
	});

	it("marks PRs without council runs as per-PR failures", async () => {
		const state = buildState([1, 2], 1);
		state.council.lastRun = councilRun(1);
		const result = await runJudgeAllAction({
			state,
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch: async ({ reviewer: r }) => ({
				reviewerId: r.id,
				exitCode: 0,
				finalAssistantText: judgeJson("ok"),
				stderr: "",
				warnings: [],
			}),
			fetchers: fetchers(),
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const second = result.run.entries.find((e) => e.prNumber === 2);
		expect(second?.run).toBeNull();
		expect(second?.error).toMatch(/No council run available/);
	});

	it("preserves a stack mate's council run and decisions", async () => {
		const state = buildState([1, 2], 1);
		state.council.lastRun = councilRun(1);
		state.stackRuns.set(2, {
			lastRun: councilRun(2),
			lastJudge: null,
			lastCritique: null,
			decisions: new Map([
				[
					9,
					{
						findingId: 9,
						verdict: "dismiss",
						decidedAt: "2026-05-20T15:00:00Z",
						reason: "noise",
					},
				],
			]),
		});

		await runJudgeAllAction({
			state,
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch: async ({ reviewer: r }) => ({
				reviewerId: r.id,
				exitCode: 0,
				finalAssistantText: judgeJson("ok"),
				stderr: "",
				warnings: [],
			}),
			fetchers: fetchers(),
		});

		const snap = state.stackRuns.get(2);
		expect(snap?.lastRun?.target.prNumber).toBe(2);
		expect(snap?.lastJudge).not.toBeNull();
		expect(snap?.decisions.get(9)?.verdict).toBe("dismiss");
	});
});

describe("formatJudgeAllSummary", () => {
	it("highlights the cursor PR and counts failures", () => {
		const text = formatJudgeAllSummary({
			id: "judge-all-test",
			startedAt: "2026-05-20T15:00:00Z",
			cursorPrNumber: 1,
			entries: [
				{
					prNumber: 1,
					error: null,
					run: {
						id: "judge-1",
						startedAt: "2026-05-20T15:00:00Z",
						judgeReviewerId: "judge",
						selfSignal: null,
						consolidatedFindings: [finding(2)],
						warnings: [],
					},
				},
				{ prNumber: 2, run: null, error: "No council run available" },
			],
		});
		expect(text).toMatch(/▶ PR #1: 1 consolidated finding/);
		expect(text).toMatch(/PR #2: No council run available/);
		expect(text).toMatch(/1 judge completed, 1 failed/);
	});
});

function extractShaNumber(path: string): string {
	const match = path.match(/sha-(\d+)/);
	return match?.[1] ?? "unknown";
}

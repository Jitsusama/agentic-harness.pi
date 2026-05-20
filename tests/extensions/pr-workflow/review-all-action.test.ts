/** Tests for the stack-level review-all wrapper. */

import { describe, expect, it } from "vitest";
import type { CouncilDispatch } from "../../../extensions/pr-workflow/council.js";
import {
	formatReviewAllSummary,
	runReviewAllAction,
} from "../../../extensions/pr-workflow/review-all-action.js";
import type { CouncilReviewer } from "../../../extensions/pr-workflow/reviewer.js";
import type { Stack } from "../../../extensions/pr-workflow/stack.js";
import { createPrWorkflowState } from "../../../extensions/pr-workflow/state.js";
import { WorktreeRegistry } from "../../../extensions/pr-workflow/worktree.js";
import { fakeProvider } from "./council.test-helpers.js";
import { expectFailure, prMetadata } from "./fixtures.js";

function reviewer(id: string): CouncilReviewer {
	return { id, model: "anthropic/claude-haiku-4-5" };
}

function buildState() {
	const state = createPrWorkflowState();
	state.council.roster = [reviewer("fast")];
	state.council.judge = reviewer("judge");
	const entries: Stack["entries"] = [1, 2].map((number) => ({
		reference: { owner: "o", repo: "r", number },
		title: `PR ${number}`,
		baseRefName: "main",
		headRefName: `f${number}`,
	}));
	state.pr = {
		reference: { owner: "o", repo: "r", number: 1 },
		loadedAt: "2026-05-20T15:00:00Z",
		metadata: prMetadata({ title: "PR 1", head: { ref: "f1", sha: "sha-1" } }),
		files: [],
		stack: { entries, cursorIndex: 0, cursorChildren: [] },
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
		diff: async () => [],
	};
}

const dispatch: CouncilDispatch = async ({ reviewer: r }) => {
	if (r.id === "judge") {
		return {
			reviewerId: r.id,
			exitCode: 0,
			finalAssistantText: [
				"```json",
				JSON.stringify({
					selfSignal: { confidence: "medium", rationale: "ok" },
					findings: [
						{
							location: { kind: "global" },
							label: "issue",
							subject: "judged",
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
		};
	}
	return {
		reviewerId: r.id,
		exitCode: 0,
		finalAssistantText: JSON.stringify({
			findings: [
				{
					location: { kind: "global" },
					label: "issue",
					subject: "round one",
					discussion: "d",
				},
			],
		}),
		stderr: "",
		warnings: [],
	};
};

describe("runReviewAllAction", () => {
	it("runs council-all and judge-all in sequence", async () => {
		const state = buildState();
		const result = await runReviewAllAction({
			state,
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch,
			fetchers: fetchers(),
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.run.council.entries).toHaveLength(2);
		expect(result.run.judge.entries).toHaveLength(2);
		expect(state.council.lastRun?.target.prNumber).toBe(1);
		expect(state.council.lastJudge?.consolidatedFindings[0]?.subject).toBe(
			"judged",
		);
		expect(state.stackRuns.get(2)?.lastRun?.target.prNumber).toBe(2);
		expect(state.stackRuns.get(2)?.lastJudge).not.toBeNull();
	});

	it("returns the council guard error without running anything else", async () => {
		const state = createPrWorkflowState();
		const result = await runReviewAllAction({
			state,
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch,
			fetchers: fetchers(),
		});
		expect(expectFailure(result).error).toMatch(/No PR is loaded/);
	});
});

describe("formatReviewAllSummary", () => {
	it("combines council and judge summaries", () => {
		const state = buildState();
		const text = formatReviewAllSummary({
			council: {
				id: "council-all-1",
				startedAt: "2026-05-20T15:00:00Z",
				cursorPrNumber: 1,
				entries: [
					{
						prNumber: 1,
						error: null,
						run: {
							id: "c1",
							startedAt: "2026-05-20T15:00:00Z",
							target: { kind: "diff", prNumber: 1 },
							reviewerOutputs: [],
						},
					},
				],
			},
			judge: {
				id: "judge-all-1",
				startedAt: "2026-05-20T15:00:00Z",
				cursorPrNumber: 1,
				entries: [
					{
						prNumber: 1,
						error: null,
						run: {
							id: "j1",
							startedAt: "2026-05-20T15:00:00Z",
							judgeReviewerId: "judge",
							selfSignal: null,
							consolidatedFindings: [],
							warnings: [],
						},
					},
				],
			},
		});
		expect(text).toContain("Council-all council-all-1");
		expect(text).toContain("Judge-all judge-all-1");
		expect(text).toContain("Use action=findings");
		expect(state.pr?.reference.number).toBe(1);
	});
});

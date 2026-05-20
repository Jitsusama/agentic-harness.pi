/**
 * Tests for the multi-PR council fan-out action.
 *
 * `runCouncilAllAction` is Phase A of the stack-wide
 * redesign. It fans the existing per-PR council across
 * every entry in the loaded stack and stashes each PR's
 * result into the right slot (`council.lastRun` for the
 * cursor; `stackRuns` for the rest).
 *
 * These tests work in terms of observable outcomes:
 * what shape comes back from the action, where each PR's
 * run lands in state, what messaging the formatter
 * emits on partial failures.
 */

import { describe, expect, it } from "vitest";
import type { CouncilDispatch } from "../../../extensions/pr-workflow/council.js";
import {
	formatCouncilAllSummary,
	runCouncilAllAction,
} from "../../../extensions/pr-workflow/council-all-action.js";
import type { PrMetadata } from "../../../extensions/pr-workflow/fetch.js";
import type { CouncilReviewer } from "../../../extensions/pr-workflow/reviewer.js";
import type { Stack } from "../../../extensions/pr-workflow/stack.js";
import {
	createPrWorkflowState,
	type PrWorkflowState,
} from "../../../extensions/pr-workflow/state.js";
import { WorktreeRegistry } from "../../../extensions/pr-workflow/worktree.js";
import { fakeProvider } from "./council.test-helpers.js";
import { prMetadata } from "./fixtures.js";

function reviewer(id: string): CouncilReviewer {
	return { id, model: "anthropic/claude-haiku-4-5" };
}

function buildState(
	stackNumbers: number[],
	cursor: number = stackNumbers[0],
): PrWorkflowState {
	const state = createPrWorkflowState();
	state.council.roster = [reviewer("fast"), reviewer("slow")];
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
			cursorIndex: stackNumbers.indexOf(cursor),
			cursorChildren: [],
		},
	};
	return state;
}

function fakeFetchers(metadataByNumber: Record<number, PrMetadata> = {}) {
	return {
		metadata: async (ref: { number: number }) => {
			const m =
				metadataByNumber[ref.number] ??
				prMetadata({
					title: `PR ${ref.number}`,
					head: { ref: `f${ref.number}`, sha: `sha-${ref.number}` },
				});
			return m;
		},
		diff: async () => [],
	};
}

function findings(text: string) {
	return {
		exitCode: 0,
		finalAssistantText: text,
		stderr: "",
		warnings: [],
	};
}

describe("runCouncilAllAction guards", () => {
	it("refuses when no PR is loaded", async () => {
		const state = createPrWorkflowState();
		const result = await runCouncilAllAction({
			state,
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch: (async () => ({})) as unknown as CouncilDispatch,
			fetchers: fakeFetchers(),
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatch(/No PR is loaded/);
	});

	it("refuses when the loaded PR has no stack-mates", async () => {
		const state = buildState([1]);
		const result = await runCouncilAllAction({
			state,
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch: (async () => ({})) as unknown as CouncilDispatch,
			fetchers: fakeFetchers(),
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatch(/multi-PR stack/);
	});

	it("refuses when no roster has been configured", async () => {
		const state = buildState([1, 2]);
		state.council.roster = [];
		const result = await runCouncilAllAction({
			state,
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch: (async () => ({})) as unknown as CouncilDispatch,
			fetchers: fakeFetchers(),
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatch(/Council roster is empty/);
	});

	it("refuses when no judge has been configured", async () => {
		const state = buildState([1, 2]);
		state.council.judge = null;
		const result = await runCouncilAllAction({
			state,
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch: (async () => ({})) as unknown as CouncilDispatch,
			fetchers: fakeFetchers(),
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatch(/Judge not configured/);
	});
});

describe("runCouncilAllAction happy path", () => {
	it("runs the council against every stack entry and stashes results", async () => {
		const state = buildState([1, 2, 3], 2);
		const dispatched: number[] = [];
		const dispatch: CouncilDispatch = async ({ reviewer: r, cwd }) => {
			// `cwd` is the worktree path; the fake provider
			// returns a unique path per SHA so we can use it
			// as a proxy for "the right PR's worktree".
			dispatched.push(extractPrNumber(cwd));
			return {
				...findings(
					JSON.stringify({
						findings: [
							{
								location: { kind: "global" },
								label: "issue",
								subject: `from ${r.id}`,
								discussion: "d",
							},
						],
					}),
				),
				reviewerId: r.id,
			};
		};

		const result = await runCouncilAllAction({
			state,
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch,
			fetchers: fakeFetchers(),
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.run.cursorPrNumber).toBe(2);
		expect(result.run.entries.map((e) => e.prNumber)).toEqual([1, 2, 3]);
		expect(result.run.entries.every((e) => e.run !== null)).toBe(true);

		// Cursor PR's run is live as the council head.
		expect(state.council.lastRun?.target.prNumber).toBe(2);
		// Non-cursor PRs are stashed by number.
		expect(state.stackRuns.get(1)?.lastRun?.target.prNumber).toBe(1);
		expect(state.stackRuns.get(3)?.lastRun?.target.prNumber).toBe(3);
		expect(state.stackRuns.has(2)).toBe(false);
	});

	it("isolates per-PR failures so the rest of the stack still completes", async () => {
		const state = buildState([1, 2, 3], 1);
		const dispatch: CouncilDispatch = async ({ reviewer: r }) => {
			return { ...findings("{}"), reviewerId: r.id };
		};

		const result = await runCouncilAllAction({
			state,
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch,
			fetchers: {
				metadata: async (ref) => {
					if (ref.number === 3) throw new Error("forbidden");
					return prMetadata({
						title: `PR ${ref.number}`,
						head: { ref: `f${ref.number}`, sha: `sha-${ref.number}` },
					});
				},
				diff: async () => [],
			},
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const byNumber = Object.fromEntries(
			result.run.entries.map((e) => [e.prNumber, e]),
		);
		expect(byNumber[1]?.run).not.toBeNull();
		expect(byNumber[2]?.run).not.toBeNull();
		expect(byNumber[3]?.run).toBeNull();
		expect(byNumber[3]?.error).toMatch(/forbidden/);
	});

	it("preserves prior judge / decisions on stack mates when re-running the council", async () => {
		const state = buildState([1, 2], 1);
		state.stackRuns.set(2, {
			lastRun: null,
			lastJudge: {
				id: "j-old",
				startedAt: "2026-05-19T00:00:00Z",
				judgeReviewerId: "judge",
				selfSignal: null,
				consolidatedFindings: [],
				warnings: [],
			},
			lastCritique: null,
			decisions: new Map([
				[
					1,
					{
						findingId: 1,
						verdict: "endorse",
						decidedAt: "2026-05-19T01:00:00Z",
					},
				],
			]),
		});

		const dispatch: CouncilDispatch = async ({ reviewer: r }) => ({
			...findings("{}"),
			reviewerId: r.id,
		});

		await runCouncilAllAction({
			state,
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch,
			fetchers: fakeFetchers(),
		});

		const snap = state.stackRuns.get(2);
		expect(snap?.lastJudge?.id).toBe("j-old");
		expect(snap?.decisions.get(1)?.verdict).toBe("endorse");
		expect(snap?.lastRun).not.toBeNull();
	});
});

describe("formatCouncilAllSummary", () => {
	it("highlights the cursor PR and counts successes/failures", () => {
		const text = formatCouncilAllSummary({
			id: "council-all-test",
			startedAt: "2026-05-20T14:00:00Z",
			cursorPrNumber: 2,
			entries: [
				{
					prNumber: 1,
					error: null,
					run: {
						id: "r1",
						startedAt: "2026-05-20T14:00:00Z",
						target: { kind: "diff", prNumber: 1 },
						reviewerOutputs: [
							{ reviewerId: "fast", findings: [], warnings: [] },
						],
					},
				},
				{
					prNumber: 2,
					error: null,
					run: {
						id: "r2",
						startedAt: "2026-05-20T14:00:00Z",
						target: { kind: "diff", prNumber: 2 },
						reviewerOutputs: [
							{ reviewerId: "fast", findings: [], warnings: [] },
						],
					},
				},
				{
					prNumber: 3,
					error: "metadata fetch failed",
					run: null,
				},
			],
		});
		expect(text).toMatch(/▶ PR #2:/);
		expect(text).toMatch(/ {2}PR #1:/);
		expect(text).toMatch(/PR #3: metadata fetch failed/);
		expect(text).toMatch(/2 councils completed, 1 failed/);
	});
});

function extractPrNumber(path: string): number {
	const m = path.match(/sha-(\d+)/);
	return m ? Number.parseInt(m[1] ?? "0", 10) : 0;
}

import { describe, expect, it } from "vitest";
import type { Finding } from "../../../extensions/pr-workflow/findings.js";
import type { JudgeRun } from "../../../extensions/pr-workflow/judge.js";
import type { Stack } from "../../../extensions/pr-workflow/stack.js";
import type { StackCriticRun } from "../../../extensions/pr-workflow/stack-critic.js";
import {
	configureStackCritic,
	formatStackCriticSummary,
	runStackCriticAction,
} from "../../../extensions/pr-workflow/stack-critic-action.js";
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

function judgeFinding(id: number, subject: string): Finding {
	return {
		id,
		location: { kind: "global" },
		label: "issue",
		decorations: [],
		subject,
		discussion: subject,
		category: "scope",
		origin: { kind: "judge", runId: "j", judgeReviewerId: "jr" },
		state: "draft",
	};
}

function judgeRun(findings: Finding[]): JudgeRun {
	return {
		id: "judge-1",
		startedAt: "2026-05-19T00:00:00Z",
		judgeReviewerId: "jr",
		selfSignal: null,
		consolidatedFindings: findings,
		warnings: [],
	};
}

function stack(entries: Array<{ number: number; title: string }>): Stack {
	return {
		entries: entries.map((e) => ({
			reference: { owner: "o", repo: "r", number: e.number },
			title: e.title,
			baseRefName: "base",
			headRefName: `feat-${e.number}`,
		})),
		cursorIndex: 0,
		cursorChildren: [],
	};
}

function withCursorPr(prNumber: number, options: { hasJudge?: boolean } = {}) {
	const state = createPrWorkflowState();
	state.pr = {
		reference: { owner: "o", repo: "r", number: prNumber },
		loadedAt: "2026-05-19T00:00:00Z",
		metadata: prMetadata({
			title: `PR #${prNumber}`,
			url: `u/${prNumber}`,
			author: "a",
			base: { ref: "base", sha: "base-sha" },
			head: { ref: `feat-${prNumber}`, sha: `head-${prNumber}` },
		}),
		files: [],
		stack: stack([
			{ number: 1, title: "First" },
			{ number: 2, title: "Second" },
		]),
	};
	if (options.hasJudge !== false) {
		state.council.lastJudge = judgeRun([judgeFinding(1, "live")]);
	}
	return state;
}

describe("configureStackCritic", () => {
	it("sets the stack-critic reviewer in state", () => {
		const state = createPrWorkflowState();
		const result = configureStackCritic(state, {
			stackCritic: { id: "sc", model: "anthropic:claude-opus-4" },
		});
		expect(result.ok).toBe(true);
		expect(state.council.stackCritic).toEqual({
			id: "sc",
			model: "anthropic:claude-opus-4",
		});
	});

	it("rejects an empty reviewer id", () => {
		const state = createPrWorkflowState();
		const result = configureStackCritic(state, {
			stackCritic: { id: "", model: "x" },
		});
		expect(expectFailure(result).error).toMatch(/id|empty|reviewer/i);
	});
});

describe("runStackCriticAction", () => {
	it("refuses to run with no PR loaded", async () => {
		const state = createPrWorkflowState();
		state.council.stackCritic = { id: "sc" };
		const result = await runStackCriticAction({
			state,
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch: async () => {
				throw new Error("should not be called");
			},
		});
		expect(expectFailure(result).error).toMatch(/PR|load/i);
	});

	it("refuses to run with no stack discovered", async () => {
		const state = withCursorPr(1);
		// biome-ignore lint/style/noNonNullAssertion: PR set in helper
		state.pr!.stack = null;
		state.council.stackCritic = { id: "sc" };
		const result = await runStackCriticAction({
			state,
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch: async () => {
				throw new Error("should not be called");
			},
		});
		expect(expectFailure(result).error).toMatch(/stack/i);
	});

	it("refuses to run with no stack-critic reviewer configured", async () => {
		const state = withCursorPr(1);
		const result = await runStackCriticAction({
			state,
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch: async () => {
				throw new Error("should not be called");
			},
		});
		expect(expectFailure(result).error).toMatch(/stack-critic|configure/i);
	});

	it("refuses to run when no PR in the stack has judge findings", async () => {
		// Nothing to synthesize. Tells the user to judge
		// at least one PR first.
		const state = withCursorPr(1, { hasJudge: false });
		state.council.stackCritic = { id: "sc" };
		const result = await runStackCriticAction({
			state,
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch: async () => {
				throw new Error("should not be called");
			},
		});
		expect(expectFailure(result).error).toMatch(/judge|finding/i);
	});

	it("aggregates live cursor PR findings and snapshot findings from other PRs", async () => {
		const state = withCursorPr(1);
		// PR #2 was reviewed earlier and is now off-cursor.
		state.stackRuns.set(2, {
			lastRun: null,
			lastJudge: judgeRun([judgeFinding(7, "snap-finding")]),
			lastCritique: null,
			decisions: new Map(),
		});
		state.council.stackCritic = { id: "sc" };

		let capturedPrompt = "";
		const result = await runStackCriticAction({
			state,
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch: async (opts) => {
				capturedPrompt = opts.prompt;
				return {
					reviewerId: "sc",
					exitCode: 0,
					finalAssistantText: [
						"```json",
						JSON.stringify({
							findings: [
								{
									location: { kind: "global" },
									label: "issue",
									subject: "cross-pr issue",
									discussion: "spans both",
									homePrNumber: 1,
									spans: [1, 2],
								},
							],
						}),
						"```",
					].join("\n"),
					stderr: "",
					warnings: [],
				};
			},
		});

		expect(result.ok).toBe(true);
		expect(capturedPrompt).toContain("live");
		expect(capturedPrompt).toContain("snap-finding");
		expect(state.stackCritic).not.toBeNull();
		expect(state.stackCritic?.findings).toHaveLength(1);
		expect(state.stackCritic?.findings[0].homePrNumber).toBe(1);
		expect(state.stackCritic?.findings[0].spans).toEqual([1, 2]);
	});
});

describe("formatStackCriticSummary", () => {
	it("renders run id, reviewer, finding count, and per-finding home + spans", () => {
		const run: StackCriticRun = {
			id: "sc-1",
			startedAt: "2026-05-19T00:00:00Z",
			reviewerId: "sc",
			findings: [
				{
					id: 1,
					location: { kind: "global" },
					label: "issue",
					decorations: [],
					subject: "Inconsistent retry semantics",
					discussion: "x",
					category: "scope",
					origin: { kind: "stack-critic", runId: "sc-1", reviewerId: "sc" },
					state: "draft",
					homePrNumber: 2,
					spans: [1, 2, 3],
				},
			],
			warnings: [],
		};
		const text = formatStackCriticSummary(run);
		expect(text).toContain("sc-1");
		expect(text).toContain("sc");
		expect(text).toContain("Inconsistent retry semantics");
		expect(text).toContain("#2");
		expect(text).toContain("1, 2, 3");
	});

	it("surfaces warnings when present", () => {
		const run: StackCriticRun = {
			id: "sc-1",
			startedAt: "2026-05-19T00:00:00Z",
			reviewerId: "sc",
			findings: [],
			warnings: ["No JSON block"],
		};
		expect(formatStackCriticSummary(run)).toContain("No JSON block");
	});
});

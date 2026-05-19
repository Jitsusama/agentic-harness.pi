import { describe, expect, it } from "vitest";
import {
	configureCouncil,
	formatCouncilSummary,
	runCouncilAction,
} from "../../../extensions/pr-workflow/council-action.js";
import type { CouncilRun } from "../../../extensions/pr-workflow/findings.js";
import { createPrWorkflowState } from "../../../extensions/pr-workflow/state.js";
import type { WorktreeProvider } from "../../../extensions/pr-workflow/worktree.js";
import { WorktreeRegistry } from "../../../extensions/pr-workflow/worktree.js";

/**
 * These tests cover the pure-data action handlers
 * (`configureCouncil`, `runCouncilAction`,
 * `formatCouncilSummary`). The tool surface in `index.ts`
 * is a thin shell over these; the meat is here.
 */

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

describe("configureCouncil", () => {
	it("replaces the roster with the provided reviewers", async () => {
		// The user passes `reviewers` on `council-config`.
		// We do not merge; the user said "this is the
		// roster", so it is.
		const state = createPrWorkflowState();
		state.council.roster = [{ id: "old", model: "x" }];
		const result = configureCouncil(state, {
			reviewers: [
				{ id: "fast", model: "anthropic:claude-sonnet-4.5" },
				{ id: "skeptic", model: "openai:gpt-5-codex" },
			],
		});
		expect(result.ok).toBe(true);
		expect(state.council.roster).toEqual([
			{ id: "fast", model: "anthropic:claude-sonnet-4.5" },
			{ id: "skeptic", model: "openai:gpt-5-codex" },
		]);
	});

	it("rejects an empty roster — a council with no reviewers is nonsense", async () => {
		const state = createPrWorkflowState();
		const result = configureCouncil(state, { reviewers: [] });
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/empty|no reviewers|at least/i);
	});

	it("rejects reviewers with duplicate ids", async () => {
		// Reviewer ids stamp finding origin. Duplicates
		// would make the audit trail ambiguous, so refuse
		// at configure time rather than mid-run.
		const state = createPrWorkflowState();
		const result = configureCouncil(state, {
			reviewers: [
				{ id: "a", model: "x" },
				{ id: "a", model: "y" },
			],
		});
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/duplicate/i);
	});
});

describe("runCouncilAction", () => {
	it("refuses to run when no PR is loaded", async () => {
		// The whole point is to review a PR's diff. If
		// nothing's loaded, refuse with a helpful message
		// rather than running over an empty target.
		const state = createPrWorkflowState();
		state.council.roster = [{ id: "fast" }];
		const result = await runCouncilAction({
			state,
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch: async () => {
				throw new Error("should not be called");
			},
		});
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/no pr|load/i);
	});

	it("refuses to run when the roster is empty", async () => {
		const state = createPrWorkflowState();
		state.pr = {
			reference: { owner: "o", repo: "r", number: 1 },
			loadedAt: "2026-01-01T00:00:00Z",
			metadata: {
				title: "t",
				url: "https://example/1",
				state: "OPEN",
				author: "a",
				isDraft: false,
				base: { ref: "main", sha: "deadbeef" },
				head: { ref: "feat", sha: "abc1234" },
				changedFiles: 0,
				additions: 0,
				deletions: 0,
			},
			files: [],
			stack: null,
		};
		const result = await runCouncilAction({
			state,
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch: async () => {
				throw new Error("should not be called");
			},
		});
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/roster|council-config|configure/i);
	});

	it("dispatches the configured roster, stamps the run, and stores it in state", async () => {
		// On success: the roster fans out, findings come
		// back, the CouncilRun lands in
		// state.council.lastRun for subsequent rounds and
		// for `status` to surface.
		const state = createPrWorkflowState();
		state.pr = {
			reference: { owner: "o", repo: "r", number: 42 },
			loadedAt: "2026-01-01T00:00:00Z",
			metadata: {
				title: "Add foo",
				url: "https://example/42",
				state: "OPEN",
				author: "a",
				isDraft: false,
				base: { ref: "main", sha: "deadbeef" },
				head: { ref: "feat", sha: "headsha1" },
				changedFiles: 0,
				additions: 0,
				deletions: 0,
			},
			files: [],
			stack: null,
		};
		state.council.roster = [{ id: "fast" }];

		const result = await runCouncilAction({
			state,
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch: async (opts) => ({
				reviewerId: opts.reviewer.id,
				exitCode: 0,
				finalAssistantText: JSON.stringify({
					findings: [
						{
							location: { kind: "global" },
							label: "issue",
							subject: "needs work",
							discussion: "details",
						},
					],
				}),
				stderr: "",
				warnings: [],
			}),
		});
		expect(result.ok).toBe(true);
		expect(state.council.lastRun).not.toBeNull();
		const run = state.council.lastRun as CouncilRun;
		expect(run.target).toEqual({ kind: "diff", prNumber: 42 });
		expect(run.reviewerOutputs).toHaveLength(1);
		expect(run.reviewerOutputs[0].findings).toHaveLength(1);
	});
});

describe("formatCouncilSummary", () => {
	it("renders reviewer headers, finding counts and warnings into a human-readable summary", async () => {
		// The agent shows this back to the user after the
		// run. It must include enough detail to let the
		// user spot when a reviewer crashed or returned
		// nothing useful.
		const run: CouncilRun = {
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
							subject: "X",
							discussion: "Y",
							origin: {
								kind: "council",
								runId: "council-1",
								reviewerId: "fast",
							},
							state: "draft",
							category: "scope",
						},
					],
					warnings: [],
				},
				{
					reviewerId: "skeptic",
					findings: [],
					warnings: ["Pi subprocess exited non-zero (exit 1)"],
				},
			],
		};
		const text = formatCouncilSummary(run);
		expect(text).toContain("fast");
		expect(text).toContain("skeptic");
		expect(text).toContain("1 finding");
		expect(text).toMatch(/0 findings|no findings/i);
		expect(text).toContain("exit 1");
	});
});

import { describe, expect, it } from "vitest";
import {
	configureCouncil,
	formatCouncilSummary,
	retryCouncilReviewer,
	runCouncilAction,
} from "../../../extensions/pr-workflow/council-action.js";
import type { CouncilRun } from "../../../extensions/pr-workflow/findings.js";
import { createPrWorkflowState } from "../../../extensions/pr-workflow/state.js";
import type {
	WorktreeProvider,
	WorktreeRequest,
} from "../../../extensions/pr-workflow/worktree.js";
import { WorktreeRegistry } from "../../../extensions/pr-workflow/worktree.js";
import { expectFailure, prMetadata } from "./fixtures.js";

/**
 * These tests cover the pure-data action handlers
 * (`configureCouncil`, `runCouncilAction`,
 * `formatCouncilSummary`). The tool surface in `index.ts`
 * is a thin shell over these; the meat is here.
 */

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

describe("configureCouncil", () => {
	it("replaces the roster with the provided reviewers", async () => {
		// The user passes `reviewers` on `council-config`.
		// We do not merge; the user said "this is the
		// roster", so it is.
		const state = createPrWorkflowState();
		state.council.roster = [{ id: "old", model: "x" }];
		const result = configureCouncil(state, {
			reviewers: [
				{ id: "fast", model: "anthropic/claude-sonnet-4-5" },
				{ id: "skeptic", model: "openai/gpt-5-codex" },
			],
		});
		expect(result.ok).toBe(true);
		expect(state.council.roster).toEqual([
			{ id: "fast", model: "anthropic/claude-sonnet-4-5" },
			{ id: "skeptic", model: "openai/gpt-5-codex" },
		]);
	});

	it("rejects an empty roster — a council with no reviewers is nonsense", async () => {
		const state = createPrWorkflowState();
		const result = configureCouncil(state, { reviewers: [] });
		expect(expectFailure(result).error).toMatch(/empty|no reviewers|at least/i);
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
		expect(expectFailure(result).error).toMatch(/duplicate/i);
	});

	it("rejects a council reviewer id already used by the judge", async () => {
		const state = createPrWorkflowState();
		state.council.judge = { id: "judge", model: "x" };
		const result = configureCouncil(state, {
			reviewers: [{ id: "judge", model: "y" }],
		});
		expect(expectFailure(result).error).toMatch(/judge|distinct/i);
	});

	it("allows reconfiguring a locked reviewer id with the same identity", async () => {
		const state = createPrWorkflowState();
		state.participantIdentities.set("fast", {
			id: "fast",
			role: "reviewer",
			model: "model-a",
		});
		const result = configureCouncil(state, {
			reviewers: [{ id: "fast", model: "model-a" }],
		});
		expect(result.ok).toBe(true);
	});

	it("replaces a locked reviewer id when no findings reference it", async () => {
		// Re-running council-config after a failed run that
		// produced zero findings should not fail because of
		// the identity lock. Audit honesty is only meaningful
		// when findings exist.
		const state = createPrWorkflowState();
		state.participantIdentities.set("fast", {
			id: "fast",
			role: "reviewer",
			model: "model-a",
			thinkingLevel: "xhigh",
		});
		const result = configureCouncil(state, {
			reviewers: [{ id: "fast", model: "model-a", thinkingLevel: "high" }],
		});
		expect(result.ok).toBe(true);
		expect(state.participantIdentities.get("fast")).toBeUndefined();
	});

	it("still rejects a locked reviewer id when findings reference it", async () => {
		const state = createPrWorkflowState();
		state.participantIdentities.set("fast", {
			id: "fast",
			role: "reviewer",
			model: "model-a",
		});
		state.council.lastRun = {
			id: "run-1",
			startedAt: "2026-05-28T00:00:00Z",
			target: { kind: "diff", prNumber: 1 },
			reviewerOutputs: [
				{
					reviewerId: "fast",
					warnings: [],
					findings: [
						{
							id: 1,
							location: { kind: "global" },
							label: "issue",
							decorations: [],
							subject: "x",
							discussion: "y",
							category: "file",
							origin: {
								kind: "council",
								runId: "run-1",
								reviewerId: "fast",
							},
							state: "draft",
						},
					],
				},
			],
		};
		const result = configureCouncil(state, {
			reviewers: [{ id: "fast", model: "model-b" }],
		});
		expect(expectFailure(result).error).toMatch(/already used/i);
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
		expect(expectFailure(result).error).toMatch(/no pr|load/i);
	});

	it("refuses to run when the roster is empty", async () => {
		const state = createPrWorkflowState();
		state.pr = {
			reference: { owner: "o", repo: "r", number: 1 },
			loadedAt: "2026-01-01T00:00:00Z",
			metadata: prMetadata({
				title: "t",
				url: "https://example/1",
				author: "a",
				base: { ref: "main", sha: "deadbeef" },
				head: { ref: "feat", sha: "abc1234" },
			}),
			files: [],
			stack: null,
		};
		const result = await runCouncilAction({
			state,
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch: async () => {
				throw new Error("should not be called");
			},
			loadConfig: async () => ({
				ok: false,
				path: "/cfg.json",
				error: "No pr-workflow config found.",
			}),
		});
		expect(expectFailure(result).error).toMatch(
			/roster|council-config|configure/i,
		);
	});

	it("refuses to run when no judge is configured", async () => {
		const state = createPrWorkflowState();
		state.pr = {
			reference: { owner: "o", repo: "r", number: 42 },
			loadedAt: "2026-01-01T00:00:00Z",
			metadata: prMetadata({
				title: "Add foo",
				url: "https://example/42",
				author: "a",
				base: { ref: "main", sha: "deadbeef" },
				head: { ref: "feat", sha: "headsha1" },
			}),
			files: [],
			stack: null,
		};
		state.council.roster = [{ id: "fast" }];

		const result = await runCouncilAction({
			state,
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch: async () => {
				throw new Error("should not be called");
			},
			loadConfig: async () => ({
				ok: false,
				path: "/cfg.json",
				error: "No pr-workflow config found.",
			}),
		});

		expect(expectFailure(result).error).toMatch(/judge|judge-config/i);
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
			metadata: prMetadata({
				title: "Add foo",
				url: "https://example/42",
				author: "a",
				base: { ref: "main", sha: "deadbeef" },
				head: { ref: "feat", sha: "headsha1" },
			}),
			files: [],
			stack: null,
		};
		state.council.roster = [{ id: "fast" }];
		state.council.judge = { id: "judge" };
		state.nextFindingId = 7;

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
		expect(run.reviewerOutputs[0].findings[0]?.id).toBe(7);
		expect(state.nextFindingId).toBe(8);
		expect(state.participantIdentities.get("fast")).toEqual({
			id: "fast",
			role: "reviewer",
		});
	});

	it("passes the PR head branch as a worktree hint", async () => {
		const requests: WorktreeRequest[] = [];
		const state = createPrWorkflowState();
		state.pr = {
			reference: { owner: "o", repo: "r", number: 42 },
			loadedAt: "2026-01-01T00:00:00Z",
			metadata: prMetadata({
				title: "Add foo",
				url: "https://example/42",
				author: "a",
				base: { ref: "main", sha: "deadbeef" },
				head: { ref: "feature/worktree", sha: "headsha1" },
			}),
			files: [],
			stack: null,
		};
		state.council.roster = [{ id: "fast" }];
		state.council.judge = { id: "judge" };

		const result = await runCouncilAction({
			state,
			registry: new WorktreeRegistry(fakeProvider(requests)),
			dispatch: async (opts) => ({
				reviewerId: opts.reviewer.id,
				exitCode: 0,
				finalAssistantText: JSON.stringify({ findings: [] }),
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
			branch: "feature/worktree",
		});
	});

	it("clears downstream judge state when a new council run lands", async () => {
		const state = createPrWorkflowState();
		state.pr = {
			reference: { owner: "o", repo: "r", number: 42 },
			loadedAt: "2026-01-01T00:00:00Z",
			metadata: prMetadata({
				title: "Add foo",
				url: "https://example/42",
				author: "a",
				base: { ref: "main", sha: "deadbeef" },
				head: { ref: "feat", sha: "headsha1" },
			}),
			files: [],
			stack: null,
		};
		state.council.roster = [{ id: "fast" }];
		state.council.judge = { id: "judge" };
		state.council.lastJudge = {
			id: "old-judge",
			startedAt: "2026-05-20T15:00:00Z",
			judgeReviewerId: "judge",
			selfSignal: null,
			consolidatedFindings: [],
			warnings: [],
		};
		state.council.lastCritique = {
			id: "old-critique",
			startedAt: "2026-05-20T15:05:00Z",
			judgeRunId: "old-judge",
			reviewerOutputs: [],
			warnings: [],
		};
		state.council.decisions.set(1, {
			findingId: 1,
			verdict: "endorse",
			decidedAt: "2026-05-20T15:10:00Z",
		});

		const result = await runCouncilAction({
			state,
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch: async (opts) => ({
				reviewerId: opts.reviewer.id,
				exitCode: 0,
				finalAssistantText: JSON.stringify({ findings: [] }),
				stderr: "",
				warnings: [],
			}),
		});

		expect(result.ok).toBe(true);
		expect(state.council.lastRun).not.toBeNull();
		expect(state.council.lastJudge).toBeNull();
		expect(state.council.lastCritique).toBeNull();
		expect(state.council.decisions.size).toBe(0);
	});

	it("resolves each roster persona to a charter system prompt", async () => {
		// A reviewer that references a persona dispatches with that
		// persona's charter as its system prompt, resolved through
		// the injected resolveCharter. A reviewer with no persona
		// dispatches without one.
		const state = createPrWorkflowState();
		state.pr = {
			reference: { owner: "o", repo: "r", number: 42 },
			loadedAt: "2026-01-01T00:00:00Z",
			metadata: prMetadata({
				title: "Add foo",
				url: "https://example/42",
				author: "a",
				base: { ref: "main", sha: "deadbeef" },
				head: { ref: "feat", sha: "headsha1" },
			}),
			files: [],
			stack: null,
		};
		state.council.roster = [
			{ id: "esc", persona: "escalation" },
			{ id: "plain" },
		];
		state.council.judge = { id: "judge" };

		const seen = new Map<string, string | undefined>();
		const result = await runCouncilAction({
			state,
			registry: new WorktreeRegistry(fakeProvider()),
			resolveCharter: (personaId) =>
				personaId === "escalation" ? "Hunt escalation." : undefined,
			dispatch: async (opts) => {
				seen.set(opts.reviewer.id, opts.systemPrompt);
				return {
					reviewerId: opts.reviewer.id,
					exitCode: 0,
					finalAssistantText: JSON.stringify({ findings: [] }),
					stderr: "",
					warnings: [],
				};
			},
		});
		expect(result.ok).toBe(true);
		expect(seen.get("esc")).toBe("Hunt escalation.");
		expect(seen.get("plain")).toBeUndefined();
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
							decorations: [],
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

	it("shows reviewer verification state when it is available", async () => {
		const run: CouncilRun = {
			id: "council-1",
			startedAt: "2026-01-01T00:00:00Z",
			target: { kind: "diff", prNumber: 42 },
			reviewerOutputs: [
				{
					reviewerId: "fast",
					findings: [],
					warnings: [],
					verification: { called: true, ok: true, count: 0 },
				},
				{
					reviewerId: "skeptic",
					findings: [],
					warnings: [],
					verification: { called: true, ok: false },
				},
			],
		};

		const text = formatCouncilSummary(run);

		expect(text).toContain("fast — 0 findings — verified ✓");
		expect(text).toContain("skeptic — 0 findings — verification failed");
	});

	it("surfaces the verify_output message when a reviewer failed validation", async () => {
		// A reviewer that crashed verify needs the actual
		// failure reason visible at the top level, not buried
		// under retry guesswork.
		const run: CouncilRun = {
			id: "council-1",
			startedAt: "2026-01-01T00:00:00Z",
			target: { kind: "diff", prNumber: 42 },
			reviewerOutputs: [
				{
					reviewerId: "grok",
					findings: [],
					warnings: [],
					verification: {
						called: true,
						ok: false,
						message:
							"ok: false. 8 errors against stage=stack-review:\n  /perPr/769188/0/severity: must be equal to constant",
					},
				},
			],
		};

		const text = formatCouncilSummary(run);

		expect(text).toContain("verify_output failed");
		expect(text).toContain("8 errors against stage=stack-review");
	});

	it("names the failure mode when verify_output was never called", async () => {
		const run: CouncilRun = {
			id: "council-1",
			startedAt: "2026-01-01T00:00:00Z",
			target: { kind: "diff", prNumber: 42 },
			reviewerOutputs: [
				{
					reviewerId: "grok",
					findings: [],
					warnings: [],
					verification: { called: false, ok: false },
				},
			],
		};

		const text = formatCouncilSummary(run);

		expect(text).toContain("verify_output not called");
	});

	it("surfaces a retry hint for reviewers that came back empty with warnings", async () => {
		// Empty-with-warnings is the classic 'reviewer
		// crashed' shape; the user usually wants to retry
		// rather than accept a silently missing voice.
		const run: CouncilRun = {
			id: "council-1",
			startedAt: "2026-01-01T00:00:00Z",
			target: { kind: "diff", prNumber: 42 },
			reviewerOutputs: [
				{
					reviewerId: "skeptic",
					findings: [],
					warnings: ["Pi subprocess exited non-zero (exit 1)"],
				},
			],
		};
		const text = formatCouncilSummary(run);
		expect(text).toMatch(/council-retry reviewerId=skeptic/);
	});

	it("does not suggest a retry for reviewers that came back empty without warnings", async () => {
		// Empty-with-no-warnings is a legitimate 'nothing
		// to flag' verdict; suggesting retry there would
		// be noise.
		const run: CouncilRun = {
			id: "council-1",
			startedAt: "2026-01-01T00:00:00Z",
			target: { kind: "diff", prNumber: 42 },
			reviewerOutputs: [{ reviewerId: "quiet", findings: [], warnings: [] }],
		};
		const text = formatCouncilSummary(run);
		expect(text).not.toMatch(/council-retry/);
	});

	it("swaps the per-reviewer retry hint for a session-level advisory when the runtime is stale", async () => {
		// When pi was updated mid-session, every reviewer
		// fails with the same `ENOENT` on a path inside
		// `.pi/pkg/pi-X.Y.Z/`. Suggesting `council-retry`
		// for each one is misleading — no retry will succeed
		// until pi is restarted.
		const run: CouncilRun = {
			id: "council-1",
			startedAt: "2026-01-01T00:00:00Z",
			target: { kind: "diff", prNumber: 42 },
			reviewerOutputs: [
				{
					reviewerId: "opus",
					findings: [],
					warnings: [
						"Pi subprocess exited non-zero (exit 1)",
						"Pi runtime stale: subagent crashed loading `/Users/x/.pi/pkg/pi-0.75.3/package.json`, which no longer exists. Restart pi to recover.",
					],
				},
				{
					reviewerId: "gpt",
					findings: [],
					warnings: [
						"Pi subprocess exited non-zero (exit 1)",
						"Pi runtime stale: subagent crashed loading `/Users/x/.pi/pkg/pi-0.75.3/package.json`, which no longer exists. Restart pi to recover.",
					],
				},
			],
		};
		const text = formatCouncilSummary(run);
		expect(text).toMatch(/Pi runtime stale/);
		expect(text).toMatch(/restart pi/i);
		expect(text).not.toMatch(/council-retry/);
	});
});

describe("retryCouncilReviewer", () => {
	function loadedState(): ReturnType<typeof createPrWorkflowState> {
		const state = createPrWorkflowState();
		state.pr = {
			reference: { owner: "o", repo: "r", number: 42 },
			loadedAt: "2026-01-01T00:00:00Z",
			metadata: prMetadata({
				head: { ref: "feat", sha: "headsha1" },
			}),
			files: [],
			stack: null,
		};
		state.council.roster = [{ id: "fast" }, { id: "skeptic" }];
		return state;
	}

	it("refuses without a PR loaded", async () => {
		const state = createPrWorkflowState();
		state.council.roster = [{ id: "fast" }];
		const result = await retryCouncilReviewer({
			state,
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch: async () => {
				throw new Error("should not be called");
			},
			reviewerId: "fast",
		});
		expect(expectFailure(result).error).toMatch(/no pr|load/i);
	});

	it("refuses when no council has run yet", async () => {
		const state = loadedState();
		state.council.lastRun = null;
		const result = await retryCouncilReviewer({
			state,
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch: async () => {
				throw new Error("should not be called");
			},
			reviewerId: "fast",
		});
		expect(expectFailure(result).error).toMatch(
			/no council run|council first/i,
		);
	});

	it("refuses when the reviewerId is not in the roster", async () => {
		const state = loadedState();
		state.council.lastRun = {
			id: "council-1",
			startedAt: "2026-01-01T00:00:00Z",
			target: { kind: "diff", prNumber: 42 },
			reviewerOutputs: [{ reviewerId: "fast", findings: [], warnings: [] }],
		};
		const result = await retryCouncilReviewer({
			state,
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch: async () => {
				throw new Error("should not be called");
			},
			reviewerId: "ghost",
		});
		expect(expectFailure(result).error).toMatch(/ghost.*not in/i);
	});

	it("refuses when the reviewer has no prior output to replace", async () => {
		const state = loadedState();
		state.council.lastRun = {
			id: "council-1",
			startedAt: "2026-01-01T00:00:00Z",
			target: { kind: "diff", prNumber: 42 },
			reviewerOutputs: [{ reviewerId: "fast", findings: [], warnings: [] }],
		};
		const result = await retryCouncilReviewer({
			state,
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch: async () => {
				throw new Error("should not be called");
			},
			reviewerId: "skeptic",
		});
		expect(expectFailure(result).error).toMatch(
			/skeptic.*no output|last council run/i,
		);
	});

	it("substitutes the reviewer's output and allocates from the session id sequence", async () => {
		// Existing ids: fast=1, skeptic=4. Retry fast.
		// New fast output should be assigned from the
		// session-global allocator so ids are never reused
		// within the PR workflow session.
		//
		// Gaps in the id sequence are OK — the post stage
		// reads ids out of state, not by iteration order.
		const state = loadedState();
		state.nextFindingId = 5;
		state.council.lastRun = {
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
							subject: "old",
							discussion: "old",
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
					findings: [
						{
							id: 4,
							location: { kind: "global" },
							label: "issue",
							decorations: [],
							subject: "keep me",
							discussion: "d",
							origin: {
								kind: "council",
								runId: "council-1",
								reviewerId: "skeptic",
							},
							state: "draft",
							category: "scope",
						},
					],
					warnings: [],
				},
			],
		};
		const result = await retryCouncilReviewer({
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
							subject: "fresh take",
							discussion: "better this time",
						},
					],
				}),
				stderr: "",
				warnings: [],
			}),
			reviewerId: "fast",
		});
		expect(result.ok).toBe(true);
		const run = state.council.lastRun as CouncilRun;
		expect(run.reviewerOutputs).toHaveLength(2);
		const fast = run.reviewerOutputs.find((o) => o.reviewerId === "fast");
		const skeptic = run.reviewerOutputs.find((o) => o.reviewerId === "skeptic");
		expect(fast?.findings).toHaveLength(1);
		expect(fast?.findings[0].id).toBe(5);
		expect(fast?.findings[0].subject).toBe("fresh take");
		expect(state.nextFindingId).toBe(6);
		// Skeptic's pre-existing finding untouched.
		expect(skeptic?.findings[0].id).toBe(4);
		expect(skeptic?.findings[0].subject).toBe("keep me");
	});

	it("keeps the reviewer's persona charter on a retry", async () => {
		const state = loadedState();
		state.council.roster = [{ id: "fast", persona: "escalation" }];
		state.council.lastRun = {
			id: "council-1",
			startedAt: "2026-01-01T00:00:00Z",
			target: { kind: "diff", prNumber: 42 },
			reviewerOutputs: [{ reviewerId: "fast", findings: [], warnings: [] }],
		};
		let captured: string | undefined;
		const result = await retryCouncilReviewer({
			state,
			registry: new WorktreeRegistry(fakeProvider()),
			resolveCharter: (personaId) =>
				personaId === "escalation" ? "Hunt escalation." : undefined,
			dispatch: async (opts) => {
				captured = opts.systemPrompt;
				return {
					reviewerId: opts.reviewer.id,
					exitCode: 0,
					finalAssistantText: JSON.stringify({ findings: [] }),
					stderr: "",
					warnings: [],
				};
			},
			reviewerId: "fast",
		});
		expect(result.ok).toBe(true);
		expect(captured).toBe("Hunt escalation.");
	});
});

describe("runCouncilAction concurrency", () => {
	function loadedState(prNumber: number, headSha: string) {
		const state = createPrWorkflowState();
		state.pr = {
			reference: { owner: "o", repo: "r", number: prNumber },
			loadedAt: "2026-01-01T00:00:00Z",
			metadata: prMetadata({
				head: { ref: "feat", sha: headSha },
			}),
			files: [],
			stack: null,
		};
		state.council.roster = [{ id: "fast" }];
		state.council.judge = { id: "judge" };
		return state;
	}

	function oneFindingText(subject: string): string {
		return JSON.stringify({
			findings: [
				{
					location: { kind: "global" },
					label: "issue",
					subject,
					discussion: "d",
				},
			],
		});
	}

	it("allocates disjoint finding ids when two runs are in flight at once", async () => {
		// One shared state, two concurrent runs. A barrier holds
		// both dispatches open until both have started, so the
		// id-assignment loops cannot have run before both fan-outs
		// are simultaneously in flight. Disjoint ids prove the
		// allocator reads-and-advances state.nextFindingId at
		// assignment time, not from a pre-await snapshot.
		const state = loadedState(42, "headsha1");
		state.nextFindingId = 1;

		let release!: () => void;
		const barrier = new Promise<void>((r) => {
			release = r;
		});
		let started = 0;
		const dispatch = async (opts: { reviewer: { id: string } }) => {
			started += 1;
			if (started === 2) release();
			await barrier;
			return {
				reviewerId: opts.reviewer.id,
				exitCode: 0,
				finalAssistantText: oneFindingText("x"),
				stderr: "",
				warnings: [],
			};
		};

		const registry = new WorktreeRegistry(fakeProvider());
		const [a, b] = await Promise.all([
			runCouncilAction({ state, registry, dispatch }),
			runCouncilAction({ state, registry, dispatch }),
		]);
		expect(a.ok && b.ok).toBe(true);

		// The last run to commit owns state.council.lastRun. The
		// other got stashed nowhere (same PR), but both runs must
		// have used non-overlapping ids regardless of commit order.
		const ids = [a, b]
			.flatMap((r) => (r.ok ? r.run.reviewerOutputs : []))
			.flatMap((o) => o.findings.map((f) => f.id));
		expect(ids).toHaveLength(2);
		expect(new Set(ids).size).toBe(2);
	});

	it("commits to the PR's stackRuns slot when the cursor moved during the run", async () => {
		const state = loadedState(42, "headsha1");
		state.nextFindingId = 1;

		let release!: () => void;
		const barrier = new Promise<void>((r) => {
			release = r;
		});
		const dispatch = async (opts: { reviewer: { id: string } }) => {
			// While the run is in flight, the user navigates to a
			// different PR. The run must land on PR 42's slot, not
			// the live council slot now pointing at PR 99.
			state.pr = {
				reference: { owner: "o", repo: "r", number: 99 },
				loadedAt: "2026-01-01T00:00:00Z",
				metadata: prMetadata({ head: { ref: "other", sha: "headsha2" } }),
				files: [],
				stack: null,
			};
			release();
			await barrier;
			return {
				reviewerId: opts.reviewer.id,
				exitCode: 0,
				finalAssistantText: oneFindingText("pinned"),
				stderr: "",
				warnings: [],
			};
		};

		const registry = new WorktreeRegistry(fakeProvider());
		const runPromise = runCouncilAction({ state, registry, dispatch });
		await barrier;
		const result = await runPromise;
		expect(result.ok).toBe(true);

		// The run pinned to PR 42 must not have clobbered the live
		// council slot (now on PR 99); it lands in stackRuns[42].
		expect(state.stackRuns.get(42)?.lastRun).not.toBeUndefined();
		expect(state.stackRuns.get(42)?.lastRun?.target.prNumber).toBe(42);
		expect(state.council.lastRun).toBeNull();
	});
});

import { describe, expect, it } from "vitest";
import type { CouncilProgress } from "../../../extensions/pr-workflow/council-progress.js";
import type { CouncilRun } from "../../../extensions/pr-workflow/findings.js";
import {
	buildJudgePrompt,
	type JudgeParseContext,
	parseJudgeOutput,
	runJudge,
} from "../../../extensions/pr-workflow/judge.js";
import type { CouncilReviewer } from "../../../extensions/pr-workflow/reviewer.js";
import {
	type WorktreeProvider,
	WorktreeRegistry,
	type WorktreeRequest,
} from "../../../extensions/pr-workflow/worktree.js";

/**
 * The judge round consolidates round-1 reviewer outputs
 * into a single coherent finding list. These tests cover:
 *
 *   - The prompt rendered to the judge model carries the
 *     reviewer findings, attribution, and the requested
 *     output schema.
 *   - The parser extracts both `selfSignal` and the
 *     consolidated `findings` array; stamps origin with
 *     `kind: "judge"`; populates `agreement.raisedBy` and
 *     `agreement.sourceFindingIds`.
 *   - The orchestrator wires worktree, dispatch, and
 *     parser end-to-end, producing a JudgeRun.
 */

function council(): CouncilRun {
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
						subject: "Missing null check in handlers.ts",
						discussion: "Crash if user is unset",
						category: "scope",
						origin: { kind: "council", runId: "council-1", reviewerId: "fast" },
						state: "draft",
					},
					{
						id: 2,
						location: { kind: "file", file: "lib/x.ts" },
						label: "nitpick",
						decorations: [],
						subject: "Variable name unclear",
						discussion: "rename `t` to `target`",
						category: "file",
						origin: { kind: "council", runId: "council-1", reviewerId: "fast" },
						state: "draft",
					},
				],
				warnings: [],
			},
			{
				reviewerId: "skeptic",
				findings: [
					{
						id: 3,
						location: { kind: "global" },
						label: "issue",
						decorations: [],
						subject: "handlers.ts crashes on null user",
						discussion: "Same as fast saw",
						category: "scope",
						origin: {
							kind: "council",
							runId: "council-1",
							reviewerId: "skeptic",
						},
						state: "draft",
					},
				],
				warnings: [],
			},
		],
	};
}

describe("buildJudgePrompt", () => {
	it("includes every round-1 finding with its reviewer attribution and source id", async () => {
		const text = buildJudgePrompt({ council: council() });
		// Each reviewer's id appears
		expect(text).toContain("fast");
		expect(text).toContain("skeptic");
		// Each round-1 finding subject is present
		expect(text).toContain("Missing null check in handlers.ts");
		expect(text).toContain("Variable name unclear");
		expect(text).toContain("handlers.ts crashes on null user");
		// Source ids carried through so the judge can
		// reference them in sourceFindingIds.
		expect(text).toMatch(/\b1\b/);
		expect(text).toMatch(/\b3\b/);
	});

	it("instructs the judge to emit a JSON block with selfSignal + findings + agreement metadata", async () => {
		const text = buildJudgePrompt({ council: council() });
		expect(text).toContain("```json");
		expect(text).toContain("selfSignal");
		expect(text).toMatch(/raisedBy/i);
		expect(text).toMatch(/sourceFindingIds/i);
	});

	it("instructs the judge to synthesize, not concatenate", async () => {
		// Design doc 12 §Prompt baseline — "Active
		// Synthesis" pattern. Wording is load-bearing.
		const text = buildJudgePrompt({ council: council() });
		expect(text).toMatch(/synthesize|consolidate|merge similar/i);
	});

	it("instructs judge tools to stay inside the worktree", async () => {
		const text = buildJudgePrompt({ council: council() });
		expect(text).toContain("current working directory");
		expect(text).toContain("Stay inside");
		expect(text).toContain("Do not search `/`");
		expect(text).toContain("`/Users`");
		expect(text).toContain("`$HOME`");
		expect(text).toContain("Never run commands like `find /`");
		expect(text).toContain("Do not roam the filesystem");
		expect(text).toContain("`rg`");
	});

	it("instructs judges to load relevant review and quality skills generically", async () => {
		const text = buildJudgePrompt({ council: council() });
		expect(text).toContain("Pi skills");
		expect(text).toContain("project-level");
		expect(text).toContain("user-level");
		expect(text).toContain("SKILL.md");
		expect(text).toContain("code review");
		expect(text).toContain("code quality");
		expect(text).not.toContain("code-review-standard");
		expect(text).not.toContain("comment-format");
	});

	it("defines the judge quality bar for curating council findings", async () => {
		const text = buildJudgePrompt({ council: council() });
		expect(text).toContain("Review quality standard");
		expect(text).toContain("Judge synthesis objective");
		expect(text).toContain("small, high-signal candidate review");
		expect(text).toContain("drop weak or taste-only findings");
		expect(text).toContain("Downgrade speculative claims");
		expect(text).toContain("excellent human review");
	});

	it("embeds the judge JSON schema and instructs verify_output", async () => {
		// The judge subagent gets pr-workflow-verify
		// loaded so it can self-validate before ending.
		// The prompt must teach the model to USE the tool
		// and embed the schema it's being validated
		// against. We pin load-bearing markers, not exact
		// JSON formatting.
		const text = buildJudgePrompt({ council: council() });
		expect(text).toContain("verify_output");
		expect(text).toMatch(/stage[=:].?["']?judge/i);
		expect(text).toMatch(/JSON Schema/i);
		// Label vocabulary present (schema embedded).
		expect(text).toContain("praise");
		expect(text).toContain("note");
		expect(text).not.toContain("typo");
		expect(text).not.toContain("polish");
		expect(text).not.toContain("quibble");
	});
});

describe("parseJudgeOutput", () => {
	const CTX: JudgeParseContext = {
		runId: "judge-1",
		judgeReviewerId: "judge",
		startId: 100,
	};

	it("extracts selfSignal and consolidated findings from a fenced JSON block", async () => {
		const text = [
			"Thinking...",
			"```json",
			JSON.stringify({
				selfSignal: { confidence: "high", rationale: "unanimous" },
				findings: [
					{
						location: { kind: "global" },
						label: "issue",
						subject: "Missing null check",
						discussion: "consolidated",
						raisedBy: ["fast", "skeptic"],
						sourceFindingIds: [1, 3],
					},
				],
			}),
			"```",
		].join("\n");
		const result = parseJudgeOutput(text, CTX);
		expect(result.selfSignal).toEqual({
			confidence: "high",
			rationale: "unanimous",
		});
		expect(result.findings).toHaveLength(1);
		const f = result.findings[0];
		expect(f.subject).toBe("Missing null check");
		expect(f.agreement?.raisedBy).toEqual(["fast", "skeptic"]);
		expect(f.agreement?.sourceFindingIds).toEqual([1, 3]);
	});

	it("stamps origin as kind: 'judge' with runId and judgeReviewerId", async () => {
		// Provenance: a downstream consumer needs to tell
		// "this is the consolidated finding" from "this is
		// the raw reviewer finding."
		const text = [
			"```json",
			JSON.stringify({
				findings: [
					{
						location: { kind: "global" },
						label: "issue",
						subject: "S",
						discussion: "D",
					},
				],
			}),
			"```",
		].join("\n");
		const result = parseJudgeOutput(text, CTX);
		expect(result.findings[0].origin).toEqual({
			kind: "judge",
			runId: "judge-1",
			judgeReviewerId: "judge",
		});
	});

	it("assigns ids monotonically starting at startId", async () => {
		// Findings from the judge live in the same id
		// namespace as round-1; the orchestrator allocates
		// startId past the round-1 ceiling.
		const text = [
			"```json",
			JSON.stringify({
				findings: [
					{
						location: { kind: "global" },
						label: "issue",
						subject: "A",
						discussion: "D",
					},
					{
						location: { kind: "global" },
						label: "issue",
						subject: "B",
						discussion: "D",
					},
				],
			}),
			"```",
		].join("\n");
		const result = parseJudgeOutput(text, CTX);
		expect(result.findings.map((f) => f.id)).toEqual([100, 101]);
	});

	it("returns selfSignal: null when the judge omits it", async () => {
		const text = ["```json", JSON.stringify({ findings: [] }), "```"].join(
			"\n",
		);
		const result = parseJudgeOutput(text, CTX);
		expect(result.selfSignal).toBeNull();
		expect(result.findings).toHaveLength(0);
	});

	it("keeps a judge finding that omits agreement metadata entirely", async () => {
		// A judge insight that came purely from the judge
		// (not from any reviewer) has no `raisedBy` /
		// `sourceFindingIds`. The schema treats those
		// fields as optional so absence is fine.
		const text = [
			"```json",
			JSON.stringify({
				findings: [
					{
						location: { kind: "global" },
						label: "issue",
						subject: "Lone judge insight",
						discussion: "D",
					},
				],
			}),
			"```",
		].join("\n");
		const result = parseJudgeOutput(text, CTX);
		expect(result.findings).toHaveLength(1);
		expect(result.findings[0].agreement).toBeUndefined();
	});

	it("drops a judge finding whose agreement fields are the wrong type", async () => {
		// Agreement metadata is optional but when present
		// must be well-typed. A judge that emits
		// `raisedBy: "fast"` instead of `["fast"]` is
		// emitting malformed output that the parent's
		// schema rejects. The whole finding is dropped
		// with a warning; the subagent's `verify_output`
		// loop would have caught this before emission.
		const text = [
			"```json",
			JSON.stringify({
				findings: [
					{
						location: { kind: "global" },
						label: "issue",
						subject: "Lone judge insight",
						discussion: "D",
						raisedBy: "not-an-array",
						sourceFindingIds: ["nope"],
					},
				],
			}),
			"```",
		].join("\n");
		const result = parseJudgeOutput(text, CTX);
		expect(result.findings).toHaveLength(0);
		expect(result.warnings.length).toBeGreaterThan(0);
	});

	it("emits a warning and returns empty when no JSON block is found", async () => {
		const result = parseJudgeOutput("just prose, no JSON", CTX);
		expect(result.findings).toHaveLength(0);
		expect(result.warnings.length).toBeGreaterThan(0);
	});
});

describe("runJudge", () => {
	const JUDGE: CouncilReviewer = {
		id: "judge",
		model: "anthropic/claude-opus-4-7",
	};

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

	it("dispatches the judge once with the council prompt and worktree cwd", async () => {
		// Single call; the judge isn't fanned out. Cwd is
		// the same worktree the reviewers used so the
		// judge can pull in code context if it asks.
		const calls: Array<{ reviewerId: string; cwd: string }> = [];
		const result = await runJudge({
			runId: "judge-1",
			council: council(),
			judge: JUDGE,
			target: {
				owner: "o",
				repo: "r",
				sha: "abc",
			},
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch: async (opts) => {
				calls.push({ reviewerId: opts.reviewer.id, cwd: opts.cwd });
				return {
					reviewerId: opts.reviewer.id,
					exitCode: 0,
					finalAssistantText: [
						"```json",
						JSON.stringify({
							selfSignal: { confidence: "high", rationale: "ok" },
							findings: [
								{
									location: { kind: "global" },
									label: "issue",
									subject: "consolidated",
									discussion: "d",
									raisedBy: ["fast", "skeptic"],
									sourceFindingIds: [1, 3],
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
		expect(calls).toHaveLength(1);
		expect(calls[0].reviewerId).toBe("judge");
		expect(calls[0].cwd).toBe("/wt/abc");
		expect(result.consolidatedFindings).toHaveLength(1);
		expect(result.selfSignal?.confidence).toBe("high");
	});

	it("passes the PR head branch as a worktree hint", async () => {
		const requests: WorktreeRequest[] = [];
		const result = await runJudge({
			runId: "judge-1",
			council: council(),
			judge: JUDGE,
			target: { owner: "o", repo: "r", sha: "abc", branch: "feature/judge" },
			registry: new WorktreeRegistry(fakeProvider(requests)),
			dispatch: async () => ({
				reviewerId: "judge",
				exitCode: 0,
				finalAssistantText: JSON.stringify({ findings: [] }),
				stderr: "",
				warnings: [],
			}),
		});

		expect(result.warnings).toEqual([]);
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({
			owner: "o",
			repo: "r",
			sha: "abc",
			branch: "feature/judge",
		});
	});

	it("allocates judge finding ids past the council's last round-1 id", async () => {
		// Round-1 used ids 1..3. The judge's findings
		// must not collide; allocation continues from 4.
		const result = await runJudge({
			runId: "judge-1",
			council: council(),
			judge: JUDGE,
			target: { owner: "o", repo: "r", sha: "abc" },
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch: async () => ({
				reviewerId: "judge",
				exitCode: 0,
				finalAssistantText: [
					"```json",
					JSON.stringify({
						findings: [
							{
								location: { kind: "global" },
								label: "issue",
								subject: "A",
								discussion: "d",
							},
							{
								location: { kind: "global" },
								label: "issue",
								subject: "B",
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
		expect(result.consolidatedFindings.map((f) => f.id)).toEqual([4, 5]);
	});

	it("carries the judge subagent's usage block through to the JudgeRun", async () => {
		// The judge is a single subagent so cost tracking
		// attaches directly to the run envelope, not to a
		// per-reviewer list.
		const result = await runJudge({
			runId: "judge-cost",
			council: council(),
			judge: JUDGE,
			target: { owner: "o", repo: "r", sha: "abc" },
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch: async () => ({
				reviewerId: "judge",
				exitCode: 0,
				finalAssistantText: "```json\n{}\n```",
				stderr: "",
				warnings: [],
				usage: {
					tokens: {
						input: 500,
						output: 60,
						cacheRead: 0,
						cacheWrite: 0,
						total: 560,
					},
					cost: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						total: 0.0042,
					},
				},
			}),
		});
		expect(result.usage?.tokens.total).toBe(560);
		expect(result.usage?.cost.total).toBeCloseTo(0.0042);
	});

	it("emits live progress and stream activity while the judge runs", async () => {
		const events: string[] = [];
		const progress: CouncilProgress = {
			start(entries) {
				events.push(
					`start:${entries.map((entry) => entry.reviewer.id).join(",")}`,
				);
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
			reviewerFailed(reviewerId, error) {
				events.push(`failed:${reviewerId}:${error}`);
			},
			finish() {
				events.push("finish");
			},
		};

		await runJudge({
			runId: "judge-progress",
			council: council(),
			judge: JUDGE,
			target: { owner: "o", repo: "r", sha: "abc" },
			registry: new WorktreeRegistry(fakeProvider()),
			progress,
			dispatch: async (opts) => {
				opts.onEvent?.({
					type: "tool_execution_start",
					toolName: "read",
					args: { path: "judge.ts" },
				});
				return {
					reviewerId: opts.reviewer.id,
					exitCode: 0,
					finalAssistantText:
						'```json\n{"findings":[{"location":{"kind":"global"},"label":"issue","subject":"A","discussion":"d"}]}\n```',
					stderr: "",
					warnings: [],
				};
			},
		});

		expect(events).toEqual([
			"start:judge",
			"started:judge",
			"activity:judge:reading judge.ts",
			"completed:judge:1",
			"finish",
		]);
	});

	it("surfaces dispatch warnings on the JudgeRun", async () => {
		const result = await runJudge({
			runId: "judge-1",
			council: council(),
			judge: JUDGE,
			target: { owner: "o", repo: "r", sha: "abc" },
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch: async () => ({
				reviewerId: "judge",
				exitCode: 1,
				finalAssistantText: "",
				stderr: "boom",
				warnings: ["Pi subprocess exited non-zero (exit 1)"],
			}),
		});
		expect(result.warnings.some((w) => /exit 1/.test(w))).toBe(true);
	});
});

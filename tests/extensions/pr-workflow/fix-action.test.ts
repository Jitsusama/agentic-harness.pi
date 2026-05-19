import { describe, expect, it, vi } from "vitest";
import type { CouncilRun } from "../../../extensions/pr-workflow/council.js";
import type { Finding } from "../../../extensions/pr-workflow/findings.js";
import type { RunFix } from "../../../extensions/pr-workflow/fix-action.js";
import { runFixAction } from "../../../extensions/pr-workflow/fix-action.js";
import type { JudgeRun } from "../../../extensions/pr-workflow/judge.js";
import { createPrWorkflowState } from "../../../extensions/pr-workflow/state.js";
import { decideFinding } from "../../../extensions/pr-workflow/synthesis.js";

/**
 * Fix action: drains the fix queue.
 *
 * The action picks up every finding the user queued
 * (verdict=fix) since the last council run, dispatches
 * one fix subagent per finding via the injected
 * RunFix boundary, and aggregates results.
 *
 * Two layers: the verdict (new in `synthesis.ts`) and
 * the orchestration (here). The orchestration is what
 * these tests pin.
 */

function lineFinding(id: number, file = "lib/x.ts"): Finding {
	return {
		id,
		location: { kind: "line", file, start: 10, end: 12, side: "new" },
		label: "issue",
		decorations: [],
		subject: `Subject ${id}`,
		discussion: `Discussion ${id}`,
		category: "file",
		origin: { kind: "judge", runId: "j-1", judgeReviewerId: "j" },
		state: "draft",
	};
}

function judge(findings: Finding[]): JudgeRun {
	return {
		id: "j-1",
		startedAt: "2026-01-01T00:00:00Z",
		judgeReviewerId: "j",
		selfSignal: { confidence: "high", rationale: "ok" },
		consolidatedFindings: findings,
		warnings: [],
	};
}

function council(worktreePath: string): CouncilRun {
	return {
		id: "c-1",
		startedAt: "2026-01-01T00:00:00Z",
		target: { kind: "diff", prNumber: 42 },
		reviewerOutputs: [],
		worktreePath,
	};
}

function withCouncilAndJudge(findings: Finding[]) {
	const state = createPrWorkflowState();
	state.pr = {
		reference: { owner: "o", repo: "r", number: 42 },
		loadedAt: "x",
		metadata: {
			title: "t",
			url: "u",
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
	state.council.lastRun = council("/tmp/w/run-1");
	state.council.lastJudge = judge(findings);
	return state;
}

function okFixRun(): RunFix {
	return vi.fn(async (opts) => ({
		ok: true,
		output: {
			findingId: opts.finding.id,
			summary: `applied fix for ${opts.finding.id}`,
			modifiedFiles: [`lib/file-${opts.finding.id}.ts`],
		},
		stderr: "",
	})) as unknown as RunFix;
}

describe("runFixAction", () => {
	it("requires a loaded PR", async () => {
		const state = createPrWorkflowState();
		const runFix: RunFix = vi.fn();
		const result = await runFixAction({ state, runFix });
		expect(result.ok).toBe(false);
		expect(runFix).not.toHaveBeenCalled();
	});

	it("requires a previous council run (the worktree)", async () => {
		const state = withCouncilAndJudge([lineFinding(10)]);
		state.council.lastRun = null;
		decideFinding(state, { findingId: 10, verdict: "fix" });
		const runFix: RunFix = vi.fn();
		const result = await runFixAction({ state, runFix });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toMatch(/council|worktree/i);
		}
		expect(runFix).not.toHaveBeenCalled();
	});

	it("refuses when nothing is queued for fix", async () => {
		const state = withCouncilAndJudge([lineFinding(10)]);
		decideFinding(state, { findingId: 10, verdict: "endorse" });
		const runFix: RunFix = vi.fn();
		const result = await runFixAction({ state, runFix });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toMatch(/queued|nothing|empty/i);
		}
		expect(runFix).not.toHaveBeenCalled();
	});

	it("dispatches one fix subagent per queued finding", async () => {
		const state = withCouncilAndJudge([
			lineFinding(10),
			lineFinding(11),
			lineFinding(12),
		]);
		decideFinding(state, { findingId: 10, verdict: "fix" });
		decideFinding(state, { findingId: 11, verdict: "fix" });
		decideFinding(state, { findingId: 12, verdict: "endorse" });
		const runFix = okFixRun();
		const result = await runFixAction({ state, runFix });
		expect(result.ok).toBe(true);
		expect(runFix).toHaveBeenCalledTimes(2);
	});

	it("passes the council's worktree path to each fix subagent", async () => {
		const state = withCouncilAndJudge([lineFinding(10)]);
		decideFinding(state, { findingId: 10, verdict: "fix" });
		const runFix = okFixRun();
		await runFixAction({ state, runFix });
		const call = (runFix as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(call.worktreePath).toBe("/tmp/w/run-1");
	});

	it("forwards optional user instructions to each subagent", async () => {
		const state = withCouncilAndJudge([lineFinding(10)]);
		decideFinding(state, {
			findingId: 10,
			verdict: "fix",
			instructions: "stick to the repo's helper-fn style",
		});
		const runFix = okFixRun();
		await runFixAction({ state, runFix });
		const call = (runFix as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(call.userInstructions).toBe("stick to the repo's helper-fn style");
	});

	it("aggregates per-finding results, separating succeeded from failed", async () => {
		const state = withCouncilAndJudge([lineFinding(10), lineFinding(11)]);
		decideFinding(state, { findingId: 10, verdict: "fix" });
		decideFinding(state, { findingId: 11, verdict: "fix" });
		let i = 0;
		const runFix: RunFix = vi.fn(async (opts) => {
			i += 1;
			if (i === 1) {
				return {
					ok: true,
					output: {
						findingId: opts.finding.id,
						summary: "fixed",
						modifiedFiles: ["lib/x.ts"],
					},
					stderr: "",
				};
			}
			return { ok: false, error: "compile failed" };
		});
		const result = await runFixAction({ state, runFix });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.results.succeeded).toHaveLength(1);
			expect(result.results.failed).toHaveLength(1);
			expect(result.results.failed[0].findingId).toBe(11);
		}
	});

	it("processes findings sequentially (the worktree is shared)", async () => {
		// Concurrent fix subagents on one worktree would
		// race on file writes. Serialize.
		const state = withCouncilAndJudge([lineFinding(10), lineFinding(11)]);
		decideFinding(state, { findingId: 10, verdict: "fix" });
		decideFinding(state, { findingId: 11, verdict: "fix" });
		const order: number[] = [];
		const runFix: RunFix = vi.fn(async (opts) => {
			order.push(opts.finding.id);
			await new Promise((r) => setTimeout(r, 5));
			order.push(opts.finding.id);
			return {
				ok: true,
				output: {
					findingId: opts.finding.id,
					summary: "fixed",
					modifiedFiles: [],
				},
				stderr: "",
			};
		});
		await runFixAction({ state, runFix });
		// If serialized: [10, 10, 11, 11]. If parallel:
		// [10, 11, 10, 11] or similar interleaving.
		expect(order).toEqual([10, 10, 11, 11]);
	});

	it("aggregates per-fix usage into a run-level total", async () => {
		// status panel needs an aggregate; summing usage at
		// the action boundary keeps the aggregation logic out
		// of UI code.
		const state = withCouncilAndJudge([lineFinding(10), lineFinding(11)]);
		decideFinding(state, { findingId: 10, verdict: "fix" });
		decideFinding(state, { findingId: 11, verdict: "fix" });
		const runFix = vi.fn(async (opts) => ({
			ok: true,
			output: {
				findingId: opts.finding.id,
				summary: "ok",
				modifiedFiles: [],
			},
			stderr: "",
			usage: {
				tokens: {
					input: 100,
					output: 20,
					cacheRead: 0,
					cacheWrite: 0,
					total: 120,
				},
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0.01,
				},
			},
		})) as unknown as RunFix;
		const result = await runFixAction({ state, runFix });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.usage?.tokens.total).toBe(240);
			expect(result.usage?.cost.total).toBeCloseTo(0.02);
		}
	});

	it("omits usage when no fix surfaced a usage block", async () => {
		// Backwards-compatible: a runFix that doesn't supply
		// usage (older code path, fake) results in undefined
		// aggregate.
		const state = withCouncilAndJudge([lineFinding(10)]);
		decideFinding(state, { findingId: 10, verdict: "fix" });
		const result = await runFixAction({ state, runFix: okFixRun() });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.usage).toBeUndefined();
		}
	});

	it("uses the configured fix model when one is set", async () => {
		const state = withCouncilAndJudge([lineFinding(10)]);
		state.council.fixModel = "anthropic:claude-opus-4";
		decideFinding(state, { findingId: 10, verdict: "fix" });
		const runFix = okFixRun();
		await runFixAction({ state, runFix });
		const call = (runFix as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(call.model).toBe("anthropic:claude-opus-4");
	});
});

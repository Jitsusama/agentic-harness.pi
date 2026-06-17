import { describe, expect, it, vi } from "vitest";
import { ReviewerCancelledError } from "../../../extensions/pr-workflow/cancellation.js";
import {
	type CouncilDispatch,
	runCouncil,
	runOneCouncilReviewer,
} from "../../../extensions/pr-workflow/council.js";
import {
	type WorktreeProvider,
	WorktreeRegistry,
} from "../../../extensions/pr-workflow/worktree.js";
import type { CouncilReviewer } from "../../../lib/subagent/subagent.js";

/**
 * `runCouncil` composes everything below it:
 *   - WorktreeRegistry to provision a single shared
 *     worktree for the council run.
 *   - runReviewer (injected) to dispatch each reviewer
 *     subagent.
 *   - parseReviewerOutput (inside) to turn final
 *     assistant text into Findings.
 *
 * These tests inject:
 *   - A fake WorktreeProvider so we don't touch git.
 *   - A fake runReviewer so we don't spawn pi.
 *
 * That isolates the orchestrator's behaviour: fan-out
 * concurrency, worktree provisioning, finding id
 * allocation, error handling per reviewer.
 */

function fakeWorktreeProvider(): WorktreeProvider {
	return {
		id: "fake",
		async ensure(req) {
			return {
				path: `/wt/${req.owner}-${req.repo}/${req.sha}`,
				sha: req.sha,
				providerId: "fake",
				reusable: true,
				createdAt: new Date(0),
			};
		},
		async release() {},
	};
}

const TARGET = {
	owner: "octo",
	repo: "demo",
	sha: "abc123",
	prNumber: 42,
	title: "Add foo",
	description: "Body",
	files: [],
};

const REVIEWER_A: CouncilReviewer = { id: "fast" };
const REVIEWER_B: CouncilReviewer = { id: "skeptic" };

function findingsJson(subjects: string[]): string {
	return JSON.stringify({
		findings: subjects.map((subject) => ({
			location: { kind: "global" },
			label: "issue",
			subject,
			discussion: `details for ${subject}`,
		})),
	});
}

describe("runCouncil", () => {
	it("provisions exactly one worktree shared across all reviewers", async () => {
		// The user's calibration: one worktree per council
		// run, all reviewers read from it. Avoids N
		// concurrent `git worktree add` calls.
		let ensureCalls = 0;
		const provider: WorktreeProvider = {
			id: "fake",
			async ensure(req) {
				ensureCalls++;
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
		const registry = new WorktreeRegistry(provider);
		const dispatch: CouncilDispatch = async () => ({
			reviewerId: "x",
			exitCode: 0,
			finalAssistantText: findingsJson([]),
			stderr: "",
			warnings: [],
		});
		await runCouncil({
			runId: "run-1",
			target: TARGET,
			reviewers: [REVIEWER_A, REVIEWER_B],
			registry,
			dispatch,
		});
		expect(ensureCalls).toBe(1);
	});

	it("dispatches one reviewer per CouncilReviewer entry", async () => {
		// Fan-out: N reviewers → N dispatch calls, each
		// receiving the right reviewer id.
		const dispatched: string[] = [];
		const dispatch: CouncilDispatch = async (opts) => {
			dispatched.push(opts.reviewer.id);
			return {
				reviewerId: opts.reviewer.id,
				exitCode: 0,
				finalAssistantText: findingsJson([]),
				stderr: "",
				warnings: [],
			};
		};
		await runCouncil({
			runId: "run-1",
			target: TARGET,
			reviewers: [REVIEWER_A, REVIEWER_B],
			registry: new WorktreeRegistry(fakeWorktreeProvider()),
			dispatch,
		});
		expect(dispatched).toHaveLength(2);
		expect(dispatched).toContain("fast");
		expect(dispatched).toContain("skeptic");
	});

	it("passes the worktree path as each reviewer's cwd", async () => {
		// Every reviewer investigates in the worktree we
		// provisioned. None should accidentally inherit
		// the parent pi's cwd.
		const cwds: string[] = [];
		const dispatch: CouncilDispatch = async (opts) => {
			cwds.push(opts.cwd);
			return {
				reviewerId: opts.reviewer.id,
				exitCode: 0,
				finalAssistantText: findingsJson([]),
				stderr: "",
				warnings: [],
			};
		};
		await runCouncil({
			runId: "run-1",
			target: TARGET,
			reviewers: [REVIEWER_A, REVIEWER_B],
			registry: new WorktreeRegistry(fakeWorktreeProvider()),
			dispatch,
		});
		expect(new Set(cwds).size).toBe(1);
		expect(cwds[0]).toBe("/wt/octo-demo/abc123");
	});

	it("passes each reviewer's resolved charter as the system prompt", async () => {
		// The persona charter is the reviewer's standing identity.
		// It arrives as the system prompt; reviewers with no charter
		// dispatch without one, exactly as before personas existed.
		const systemPrompts = new Map<string, string | undefined>();
		const dispatch: CouncilDispatch = async (opts) => {
			systemPrompts.set(opts.reviewer.id, opts.systemPrompt);
			return {
				reviewerId: opts.reviewer.id,
				exitCode: 0,
				finalAssistantText: findingsJson([]),
				stderr: "",
				warnings: [],
			};
		};
		await runCouncil({
			runId: "run-1",
			target: TARGET,
			reviewers: [REVIEWER_A, REVIEWER_B],
			registry: new WorktreeRegistry(fakeWorktreeProvider()),
			dispatch,
			charterFor: (id) =>
				id === "fast" ? "You review fast and shallow." : undefined,
		});
		expect(systemPrompts.get("fast")).toBe("You review fast and shallow.");
		expect(systemPrompts.get("skeptic")).toBeUndefined();
	});

	it("adds supplied review context to every reviewer prompt", async () => {
		const prompts: string[] = [];
		const dispatch: CouncilDispatch = async (opts) => {
			prompts.push(opts.prompt);
			return {
				reviewerId: opts.reviewer.id,
				exitCode: 0,
				finalAssistantText: findingsJson([]),
				stderr: "",
				warnings: [],
			};
		};

		await runCouncil({
			runId: "run-1",
			target: TARGET,
			reviewers: [REVIEWER_A, REVIEWER_B],
			registry: new WorktreeRegistry(fakeWorktreeProvider()),
			dispatch,
			promptAddendum: "Check generated manifests with context rules.",
		});

		expect(prompts).toHaveLength(2);
		expect(
			prompts.every((prompt) => prompt.includes("Provider review context")),
		).toBe(true);
		expect(prompts.every((prompt) => prompt.includes("context rules"))).toBe(
			true,
		);
	});

	it("collects findings into a CouncilRun with non-colliding ids across reviewers", async () => {
		// Two reviewers each return two findings. The
		// orchestrator stitches them into one finding
		// sequence (1, 2, 3, 4) so downstream consumers
		// can reference findings by id unambiguously.
		const dispatch: CouncilDispatch = async (opts) => ({
			reviewerId: opts.reviewer.id,
			exitCode: 0,
			finalAssistantText: findingsJson([
				`${opts.reviewer.id}-A`,
				`${opts.reviewer.id}-B`,
			]),
			stderr: "",
			warnings: [],
		});
		const run = await runCouncil({
			runId: "run-1",
			target: TARGET,
			reviewers: [REVIEWER_A, REVIEWER_B],
			registry: new WorktreeRegistry(fakeWorktreeProvider()),
			dispatch,
		});
		const allFindings = run.reviewerOutputs.flatMap((r) => r.findings);
		expect(allFindings).toHaveLength(4);
		const ids = allFindings.map((f) => f.id).sort((a, b) => a - b);
		expect(ids).toEqual([1, 2, 3, 4]);
	});

	it("stamps each finding's origin with runId and reviewerId", async () => {
		// Provenance: every council finding must trace
		// back to (a) the run it was produced in, and
		// (b) the reviewer that raised it. Without this
		// the agreement classifier and audit trail can't
		// work.
		const dispatch: CouncilDispatch = async (opts) => ({
			reviewerId: opts.reviewer.id,
			exitCode: 0,
			finalAssistantText: findingsJson(["only"]),
			stderr: "",
			warnings: [],
		});
		const run = await runCouncil({
			runId: "council-2026-01-01",
			target: TARGET,
			reviewers: [REVIEWER_A],
			registry: new WorktreeRegistry(fakeWorktreeProvider()),
			dispatch,
		});
		const finding = run.reviewerOutputs[0].findings[0];
		expect(finding.origin).toEqual({
			kind: "council",
			runId: "council-2026-01-01",
			reviewerId: "fast",
		});
	});

	it("records cancelled reviewers without losing other outputs", async () => {
		const events: string[] = [];
		const dispatch: CouncilDispatch = async (opts) => {
			if (opts.reviewer.id === "skeptic") {
				throw new ReviewerCancelledError(opts.reviewer.id);
			}
			return {
				reviewerId: opts.reviewer.id,
				exitCode: 0,
				finalAssistantText: findingsJson(["x"]),
				stderr: "",
				warnings: [],
			};
		};
		const run = await runCouncil({
			runId: "r",
			target: TARGET,
			reviewers: [REVIEWER_A, REVIEWER_B],
			registry: new WorktreeRegistry(fakeWorktreeProvider()),
			dispatch,
			progress: {
				start() {},
				reviewerStarted(id) {
					events.push(`started:${id}`);
				},
				reviewerCompleted(id) {
					events.push(`completed:${id}`);
				},
				reviewerCancelled(id) {
					events.push(`cancelled:${id}`);
				},
				reviewerFailed(id) {
					events.push(`failed:${id}`);
				},
				finish() {},
			},
		});

		const skeptic = run.reviewerOutputs.find((r) => r.reviewerId === "skeptic");
		const fast = run.reviewerOutputs.find((r) => r.reviewerId === "fast");
		expect(skeptic?.warnings).toEqual(["Reviewer cancelled by user."]);
		expect(fast?.findings).toHaveLength(1);
		expect(events).toContain("cancelled:skeptic");
		expect(events).not.toContain("failed:skeptic");
	});

	it("continues collecting outputs when one reviewer fails", async () => {
		// One reviewer crashing must not lose the others.
		// We surface the failure as a warning on that
		// reviewer's output rather than aborting the
		// whole run.
		const dispatch: CouncilDispatch = async (opts) => {
			if (opts.reviewer.id === "skeptic") {
				throw new Error("model API exploded");
			}
			return {
				reviewerId: opts.reviewer.id,
				exitCode: 0,
				finalAssistantText: findingsJson(["x"]),
				stderr: "",
				warnings: [],
			};
		};
		const run = await runCouncil({
			runId: "r",
			target: TARGET,
			reviewers: [REVIEWER_A, REVIEWER_B],
			registry: new WorktreeRegistry(fakeWorktreeProvider()),
			dispatch,
		});
		expect(run.reviewerOutputs).toHaveLength(2);
		const skeptic = run.reviewerOutputs.find((r) => r.reviewerId === "skeptic");
		const fast = run.reviewerOutputs.find((r) => r.reviewerId === "fast");
		expect(skeptic?.findings).toEqual([]);
		expect(skeptic?.warnings.some((w) => /exploded/.test(w))).toBe(true);
		expect(fast?.findings).toHaveLength(1);
	});

	it("finishes the progress panel even when worktree provisioning throws", async () => {
		// The panel installs an editor input component on
		// start; finish is the only path that restores it.
		// A throw from registry.ensure must not strand the
		// panel, or the user loses the keyboard. Regression
		// for the council teardown leak.
		const events: string[] = [];
		const throwingProvider: WorktreeProvider = {
			id: "fake",
			async ensure() {
				throw new Error("worktree not ready");
			},
			async release() {},
		};
		const dispatch: CouncilDispatch = async (opts) => ({
			reviewerId: opts.reviewer.id,
			exitCode: 0,
			finalAssistantText: findingsJson([]),
			stderr: "",
			warnings: [],
		});
		await expect(
			runCouncil({
				runId: "r",
				target: TARGET,
				reviewers: [REVIEWER_A],
				registry: new WorktreeRegistry(throwingProvider),
				dispatch,
				progress: {
					start() {},
					reviewerStarted() {},
					reviewerCompleted() {},
					reviewerCancelled() {},
					reviewerFailed() {},
					finish() {
						events.push("finish");
					},
				},
			}),
		).rejects.toThrow("worktree not ready");
		expect(events).toContain("finish");
	});

	it(
		"dispatches reviewers concurrently (not serially)",
		async () => {
			// The user expects council members to run in
			// parallel. We assert that by gating the FIRST
			// reviewer in the input order on a barrier the
			// SECOND must release. A serial impl can't
			// proceed: the first reviewer never returns
			// because nothing signals it; the second never
			// starts because the first hasn't finished.
			// Concurrent impl: both start, second releases
			// the barrier, first returns, then second.
			let release!: () => void;
			const barrier = new Promise<void>((r) => {
				release = r;
			});
			const dispatch: CouncilDispatch = async (opts) => {
				if (opts.reviewer.id === "skeptic") {
					// Waits to be "unblocked" by the second one.
					await barrier;
				} else {
					release();
				}
				return {
					reviewerId: opts.reviewer.id,
					exitCode: 0,
					finalAssistantText: findingsJson([]),
					stderr: "",
					warnings: [],
				};
			};
			// Skeptic FIRST in input order. Serial impl
			// would deadlock here (skeptic blocks; fast
			// never dispatched).
			const run = await runCouncil({
				runId: "r",
				target: TARGET,
				reviewers: [REVIEWER_B, REVIEWER_A],
				registry: new WorktreeRegistry(fakeWorktreeProvider()),
				dispatch,
			});
			expect(run.reviewerOutputs).toHaveLength(2);
		},
		{ timeout: 1000 },
	);

	it("carries each reviewer's usage block through to ReviewerOutput", async () => {
		// Cost tracking lives at the ReviewerOutput level so
		// the status panel can break down spend per reviewer.
		// The orchestrator must not silently drop the usage
		// that the dispatcher surfaced.
		const dispatch: CouncilDispatch = async (opts) => ({
			reviewerId: opts.reviewer.id,
			exitCode: 0,
			finalAssistantText: findingsJson([]),
			stderr: "",
			warnings: [],
			usage: {
				tokens: {
					input: opts.reviewer.id === "fast" ? 100 : 200,
					output: opts.reviewer.id === "fast" ? 10 : 20,
					cacheRead: 0,
					cacheWrite: 0,
					total: opts.reviewer.id === "fast" ? 110 : 220,
				},
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: opts.reviewer.id === "fast" ? 0.001 : 0.002,
				},
			},
		});
		const run = await runCouncil({
			runId: "run-usage",
			target: TARGET,
			reviewers: [REVIEWER_A, REVIEWER_B],
			registry: new WorktreeRegistry(fakeWorktreeProvider()),
			dispatch,
		});
		const fast = run.reviewerOutputs.find((r) => r.reviewerId === "fast");
		const skeptic = run.reviewerOutputs.find((r) => r.reviewerId === "skeptic");
		expect(fast?.usage?.tokens.total).toBe(110);
		expect(fast?.usage?.cost.total).toBeCloseTo(0.001);
		expect(skeptic?.usage?.tokens.total).toBe(220);
		expect(skeptic?.usage?.cost.total).toBeCloseTo(0.002);
	});

	it("leaves usage undefined for reviewers whose dispatch crashed", async () => {
		// A reviewer that never produced output also produced
		// no usage. The orchestrator records a warning and
		// omits usage rather than fabricating zeros that
		// would skew per-reviewer averages.
		const dispatch: CouncilDispatch = async (opts) => {
			if (opts.reviewer.id === "skeptic") {
				throw new Error("boom");
			}
			return {
				reviewerId: opts.reviewer.id,
				exitCode: 0,
				finalAssistantText: findingsJson([]),
				stderr: "",
				warnings: [],
				usage: {
					tokens: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						total: 2,
					},
					cost: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						total: 0.0001,
					},
				},
			};
		};
		const run = await runCouncil({
			runId: "run-mixed",
			target: TARGET,
			reviewers: [REVIEWER_A, REVIEWER_B],
			registry: new WorktreeRegistry(fakeWorktreeProvider()),
			dispatch,
		});
		const skeptic = run.reviewerOutputs.find((r) => r.reviewerId === "skeptic");
		expect(skeptic?.usage).toBeUndefined();
	});

	it("returns a CouncilRun with stable id, startedAt, and target", async () => {
		// The CouncilRun is the unit downstream consumers
		// reference for "show me the last council pass".
		// Its envelope must be present even when reviewers
		// returned no findings.
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
			const dispatch: CouncilDispatch = async (opts) => {
				vi.setSystemTime(new Date("2026-01-01T00:00:05.000Z"));
				return {
					reviewerId: opts.reviewer.id,
					exitCode: 0,
					finalAssistantText: findingsJson([]),
					stderr: "",
					warnings: [],
				};
			};
			const run = await runCouncil({
				runId: "council-42",
				target: TARGET,
				reviewers: [REVIEWER_A],
				registry: new WorktreeRegistry(fakeWorktreeProvider()),
				dispatch,
			});
			expect(run.id).toBe("council-42");
			expect(run.startedAt).toBe("2026-01-01T00:00:00.000Z");
			expect(run.target).toEqual({ kind: "diff", prNumber: 42 });
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("runOneCouncilReviewer", () => {
	it("passes the resolved charter as the system prompt on a retry", async () => {
		// A single-reviewer retry must keep the reviewer's persona
		// voice; the charter resolves the same way as in a fan-out.
		let captured: string | undefined;
		let called = false;
		const dispatch: CouncilDispatch = async (opts) => {
			captured = opts.systemPrompt;
			called = true;
			return {
				reviewerId: opts.reviewer.id,
				exitCode: 0,
				finalAssistantText: findingsJson([]),
				stderr: "",
				warnings: [],
			};
		};
		await runOneCouncilReviewer({
			runId: "run-1",
			target: TARGET,
			reviewer: REVIEWER_A,
			registry: new WorktreeRegistry(fakeWorktreeProvider()),
			dispatch,
			startId: 1,
			charterFor: (id) => (id === "fast" ? "Fast lens charter." : undefined),
		});
		expect(called).toBe(true);
		expect(captured).toBe("Fast lens charter.");
	});
});

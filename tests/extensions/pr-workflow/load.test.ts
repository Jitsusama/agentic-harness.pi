import { describe, expect, it } from "vitest";
import type { CritiqueRun } from "../../../extensions/pr-workflow/critique.js";
import type { CouncilRun } from "../../../extensions/pr-workflow/findings.js";
import type { JudgeRun } from "../../../extensions/pr-workflow/judge.js";
import { loadPr } from "../../../extensions/pr-workflow/load.js";
import { createPrWorkflowState } from "../../../extensions/pr-workflow/state.js";

describe("loadPr", () => {
	it("attaches a PR parsed from a full GitHub URL", () => {
		// A pasted URL is the most common load input. The function
		// should pull owner / repo / number out and engage the
		// workflow.
		const state = createPrWorkflowState();
		const result = loadPr(state, {
			input: "https://github.com/Jitsusama/agentic-harness.pi/pull/180",
			now: () => new Date("2026-05-18T01:00:00Z"),
		});

		expect(result.ok).toBe(true);
		expect(state.active).toBe(true);
		expect(state.pr).not.toBeNull();
		expect(state.pr?.reference).toEqual({
			owner: "Jitsusama",
			repo: "agentic-harness.pi",
			number: 180,
		});
		expect(state.pr?.loadedAt).toBe("2026-05-18T01:00:00.000Z");
	});

	it("attaches a PR parsed from owner/repo#number short form", () => {
		// The short form is the agent's preferred shape when it
		// already knows the repo. It should resolve without any
		// extra context.
		const state = createPrWorkflowState();
		const result = loadPr(state, {
			input: "Shopify/world#12345",
			now: () => new Date("2026-05-18T01:00:00Z"),
		});

		expect(result.ok).toBe(true);
		expect(state.pr?.reference).toEqual({
			owner: "Shopify",
			repo: "world",
			number: 12345,
		});
	});

	it("attaches a PR parsed from a Graphite URL", () => {
		// Graphite copies PR links in its own URL shape. They
		// still identify a GitHub owner, repo and pull request
		// number, so load should accept them directly.
		const state = createPrWorkflowState();
		const result = loadPr(state, {
			input: "https://app.graphite.com/github/pr/shop/world/738025",
			now: () => new Date("2026-05-18T01:00:00Z"),
		});

		expect(result.ok).toBe(true);
		expect(state.pr?.reference).toEqual({
			owner: "shop",
			repo: "world",
			number: 738025,
		});
	});

	it("attaches a PR parsed from a bare number when defaults are supplied", () => {
		// Inside a checkout the user often just types "#42". Without
		// repo defaults we can't resolve it; with them, we can.
		const state = createPrWorkflowState();
		const result = loadPr(state, {
			input: "#42",
			defaultRepo: { owner: "Jitsusama", repo: "neovim.pi" },
			now: () => new Date("2026-05-18T01:00:00Z"),
		});

		expect(result.ok).toBe(true);
		expect(state.pr?.reference).toEqual({
			owner: "Jitsusama",
			repo: "neovim.pi",
			number: 42,
		});
	});

	it("rejects a bare number when no defaults are supplied", () => {
		// "#42" alone is ambiguous; we surface the ambiguity rather
		// than guessing.
		const state = createPrWorkflowState();
		const result = loadPr(state, {
			input: "42",
			now: () => new Date("2026-05-18T01:00:00Z"),
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toMatch(/owner|repo|short form|URL/i);
		}
		expect(state.active).toBe(false);
		expect(state.pr).toBeNull();
	});

	it("rejects an unparseable reference and leaves state untouched", () => {
		// Garbage input must not partially engage the workflow.
		const state = createPrWorkflowState();
		const result = loadPr(state, {
			input: "not-a-pr",
			now: () => new Date("2026-05-18T01:00:00Z"),
		});

		expect(result.ok).toBe(false);
		expect(state.active).toBe(false);
		expect(state.pr).toBeNull();
	});

	it("replaces an already-loaded PR with the new one", () => {
		// Swapping PRs mid-session is normal. The latest load wins;
		// state.pr always reflects the current focus.
		const state = createPrWorkflowState();
		loadPr(state, {
			input: "Shopify/world#1",
			now: () => new Date("2026-05-18T01:00:00Z"),
		});
		const result = loadPr(state, {
			input: "Shopify/world#2",
			now: () => new Date("2026-05-18T02:00:00Z"),
		});

		expect(result.ok).toBe(true);
		expect(state.pr?.reference.number).toBe(2);
		expect(state.pr?.loadedAt).toBe("2026-05-18T02:00:00.000Z");
	});

	describe("per-PR run snapshots", () => {
		// Phase 0 of stack-aware review: when the user
		// sweeps across PRs in a stack, each PR's council
		// run, judge run, critique run and decisions should
		// survive the cursor move so they can come back to
		// it without re-running anything.

		function councilRun(id: string): CouncilRun {
			return {
				id,
				startedAt: "2026-05-18T03:00:00Z",
				target: { kind: "diff", prNumber: 1 },
				reviewerOutputs: [],
			};
		}

		function judgeRun(id: string): JudgeRun {
			return {
				id,
				startedAt: "2026-05-18T03:05:00Z",
				judgeReviewerId: "j",
				selfSignal: null,
				consolidatedFindings: [],
				warnings: [],
			};
		}

		function critiqueRun(id: string): CritiqueRun {
			return {
				id,
				startedAt: "2026-05-18T03:10:00Z",
				judgeRunId: "j-1",
				reviewerOutputs: [],
				warnings: [],
			};
		}

		it("saves the current PR's run state when loading a different PR", () => {
			const state = createPrWorkflowState();
			loadPr(state, {
				input: "Jitsusama/agentic-harness.pi#1",
				now: () => new Date("2026-05-18T01:00:00Z"),
			});
			state.council.lastRun = councilRun("c-1");
			state.council.lastJudge = judgeRun("j-1");
			state.council.lastCritique = critiqueRun("cr-1");
			state.council.decisions.set(7, {
				findingId: 7,
				verdict: "endorse",
				decidedAt: "2026-05-18T01:15:00Z",
			});

			loadPr(state, {
				input: "Jitsusama/agentic-harness.pi#2",
				now: () => new Date("2026-05-18T01:30:00Z"),
			});

			const snapshot = state.stackRuns.get(1);
			expect(snapshot).toBeDefined();
			expect(snapshot?.lastRun?.id).toBe("c-1");
			expect(snapshot?.lastJudge?.id).toBe("j-1");
			expect(snapshot?.lastCritique?.id).toBe("cr-1");
			expect(snapshot?.decisions.get(7)?.verdict).toBe("endorse");
		});

		it("restores per-PR state when loading a previously seen PR", () => {
			const state = createPrWorkflowState();
			loadPr(state, {
				input: "Jitsusama/agentic-harness.pi#1",
				now: () => new Date("2026-05-18T01:00:00Z"),
			});
			state.council.lastRun = councilRun("c-1");
			state.council.lastJudge = judgeRun("j-1");
			state.council.decisions.set(3, {
				findingId: 3,
				verdict: "dismiss",
				reason: "false positive",
				decidedAt: "2026-05-18T01:15:00Z",
			});

			// Move to PR #2 and run something there.
			loadPr(state, {
				input: "Jitsusama/agentic-harness.pi#2",
				now: () => new Date("2026-05-18T01:30:00Z"),
			});
			state.council.lastRun = councilRun("c-2");

			// Back to #1 — its state should rehydrate.
			loadPr(state, {
				input: "Jitsusama/agentic-harness.pi#1",
				now: () => new Date("2026-05-18T02:00:00Z"),
			});
			expect(state.council.lastRun?.id).toBe("c-1");
			expect(state.council.lastJudge?.id).toBe("j-1");
			expect(state.council.decisions.get(3)?.verdict).toBe("dismiss");
		});

		it("hands a fresh per-PR slate to PRs that have no snapshot", () => {
			const state = createPrWorkflowState();
			loadPr(state, {
				input: "Jitsusama/agentic-harness.pi#1",
				now: () => new Date("2026-05-18T01:00:00Z"),
			});
			state.council.lastRun = councilRun("c-1");
			state.council.lastJudge = judgeRun("j-1");
			state.council.lastCritique = critiqueRun("cr-1");
			state.council.decisions.set(5, {
				findingId: 5,
				verdict: "qualify",
				note: "only when X",
				decidedAt: "2026-05-18T01:15:00Z",
			});

			loadPr(state, {
				input: "Jitsusama/agentic-harness.pi#99",
				now: () => new Date("2026-05-18T01:30:00Z"),
			});

			expect(state.council.lastRun).toBeNull();
			expect(state.council.lastJudge).toBeNull();
			expect(state.council.lastCritique).toBeNull();
			expect(state.council.decisions.size).toBe(0);
		});

		it("preserves session-global roster and judge config across cursor moves", () => {
			// Roster and judge are the user's configuration
			// for the whole stack review, not per-PR. They
			// should never be touched by a cursor move.
			const state = createPrWorkflowState();
			state.council.roster = [{ id: "fast", model: "m" }];
			state.council.judge = { id: "j", model: "m" };

			loadPr(state, {
				input: "Jitsusama/agentic-harness.pi#1",
				now: () => new Date("2026-05-18T01:00:00Z"),
			});
			loadPr(state, {
				input: "Jitsusama/agentic-harness.pi#2",
				now: () => new Date("2026-05-18T01:30:00Z"),
			});

			expect(state.council.roster).toEqual([{ id: "fast", model: "m" }]);
			expect(state.council.judge).toEqual({ id: "j", model: "m" });
		});

		it("keeps live state intact when re-loading the same PR", () => {
			// Re-issuing `load` on the currently-loaded PR
			// shouldn't roundtrip state through stackRuns; it
			// just refreshes the timestamp.
			const state = createPrWorkflowState();
			loadPr(state, {
				input: "Jitsusama/agentic-harness.pi#1",
				now: () => new Date("2026-05-18T01:00:00Z"),
			});
			state.council.lastRun = councilRun("c-1");
			state.council.decisions.set(7, {
				findingId: 7,
				verdict: "endorse",
				decidedAt: "2026-05-18T01:15:00Z",
			});

			loadPr(state, {
				input: "Jitsusama/agentic-harness.pi#1",
				now: () => new Date("2026-05-18T01:30:00Z"),
			});

			expect(state.council.lastRun?.id).toBe("c-1");
			expect(state.council.decisions.get(7)?.verdict).toBe("endorse");
			expect(state.stackRuns.has(1)).toBe(false);
		});

		it("removes the snapshot from stackRuns when its PR is restored", () => {
			// Invariant: a PR's state lives in stackRuns ONLY
			// when it's off-cursor. When the cursor returns,
			// the snapshot moves back into live state and the
			// stackRuns entry disappears. This keeps Phase 1
			// stack-aware queries from having to dedupe.
			const state = createPrWorkflowState();
			loadPr(state, {
				input: "Jitsusama/agentic-harness.pi#1",
				now: () => new Date("2026-05-18T01:00:00Z"),
			});
			state.council.lastRun = councilRun("c-1");
			loadPr(state, {
				input: "Jitsusama/agentic-harness.pi#2",
				now: () => new Date("2026-05-18T01:30:00Z"),
			});
			expect(state.stackRuns.has(1)).toBe(true);

			loadPr(state, {
				input: "Jitsusama/agentic-harness.pi#1",
				now: () => new Date("2026-05-18T02:00:00Z"),
			});
			expect(state.stackRuns.has(1)).toBe(false);
		});

		it("does not snapshot a PR that was loaded but never reviewed", () => {
			// Snapshotting an empty slate is noise. Only PRs
			// with at least one run or decision earn a slot in
			// stackRuns.
			const state = createPrWorkflowState();
			loadPr(state, {
				input: "Jitsusama/agentic-harness.pi#1",
				now: () => new Date("2026-05-18T01:00:00Z"),
			});
			loadPr(state, {
				input: "Jitsusama/agentic-harness.pi#2",
				now: () => new Date("2026-05-18T01:30:00Z"),
			});
			expect(state.stackRuns.has(1)).toBe(false);
		});
	});
});

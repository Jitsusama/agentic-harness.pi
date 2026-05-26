import { describe, expect, it } from "vitest";
import type { CritiqueRun } from "../../../extensions/pr-workflow/critique.js";
import type {
	CouncilRun,
	Finding,
} from "../../../extensions/pr-workflow/findings.js";
import type { JudgeRun } from "../../../extensions/pr-workflow/judge.js";
import type {
	StackFinding,
	StackFindingRun,
} from "../../../extensions/pr-workflow/stack-findings.js";
import { createPrWorkflowState } from "../../../extensions/pr-workflow/state.js";
import {
	decideFinding,
	formatFindingsView,
} from "../../../extensions/pr-workflow/synthesis.js";
import { expectFailure } from "./fixtures.js";

function stackFinding(
	id: number,
	subject: string,
	homePrNumber: number,
	spans: number[],
): StackFinding {
	return {
		id,
		location: { kind: "global" },
		label: "issue",
		decorations: [],
		subject,
		discussion: "d",
		category: "scope",
		origin: { kind: "cross-PR", runId: "sc-1", reviewerId: "sc" },
		state: "draft",
		homePrNumber,
		spans,
	};
}

function stackFindingRun(findings: StackFinding[]): StackFindingRun {
	return {
		id: "sc-1",
		startedAt: "2026-05-19T00:00:00Z",
		reviewerId: "sc",
		findings,
		warnings: [],
	};
}

/**
 * Round 4 (the user) is the synthesis layer. The user
 * reads the council pipeline output, takes positions on
 * findings, and produces the final list that posts to
 * GitHub.
 *
 * This slice covers two pieces:
 *
 *   - `formatFindingsView` — read-only render of the
 *     current state (judge consolidation + critique
 *     dissent + user decisions).
 *   - `decideFinding` — mutator that sets / overrides a
 *     user decision on a single finding.
 *
 * Posting decisions to GitHub is a later slice.
 */

function makeJudge(findings: Finding[]): JudgeRun {
	return {
		id: "j-1",
		startedAt: "2026-01-01T00:05:00Z",
		judgeReviewerId: "j",
		selfSignal: { confidence: "high", rationale: "ok" },
		consolidatedFindings: findings,
		warnings: [],
	};
}

function judgedFinding(id: number, subject: string): Finding {
	return {
		id,
		location: { kind: "global" },
		label: "issue",
		decorations: [],
		subject,
		discussion: "d",
		category: "scope",
		origin: { kind: "judge", runId: "j-1", judgeReviewerId: "j" },
		state: "draft",
		agreement: { raisedBy: ["fast", "skeptic"], sourceFindingIds: [] },
	};
}

describe("formatFindingsView", () => {
	it("lists every consolidated finding with its id, subject, label and raisedBy", async () => {
		const state = createPrWorkflowState();
		state.council.lastJudge = makeJudge([
			judgedFinding(10, "Null deref"),
			judgedFinding(11, "Typo"),
		]);
		const text = formatFindingsView(state);
		expect(text).toContain("Null deref");
		expect(text).toContain("Typo");
		expect(text).toMatch(/\b10\b/);
		expect(text).toMatch(/\b11\b/);
		expect(text).toContain("fast");
		expect(text).toContain("skeptic");
	});

	it("zips critique positions in per finding", async () => {
		const state = createPrWorkflowState();
		state.council.lastJudge = makeJudge([judgedFinding(10, "Null deref")]);
		const critique: CritiqueRun = {
			id: "critique-1",
			startedAt: "2026-01-01T00:10:00Z",
			judgeRunId: "j-1",
			reviewerOutputs: [
				{
					reviewerId: "fast",
					critiques: [
						{
							reviewerId: "fast",
							findingId: 10,
							position: "agree",
							rationale: "yes",
						},
					],
					warnings: [],
				},
				{
					reviewerId: "skeptic",
					critiques: [
						{
							reviewerId: "skeptic",
							findingId: 10,
							position: "disagree",
							rationale: "false positive on this path",
						},
					],
					warnings: [],
				},
			],
			warnings: [],
		};
		state.council.lastCritique = critique;
		const text = formatFindingsView(state);
		expect(text).toContain("agree");
		expect(text).toContain("disagree");
		expect(text).toContain("false positive on this path");
	});

	it("shows the user's decision per finding when set, and 'pending' otherwise", async () => {
		const state = createPrWorkflowState();
		state.council.lastJudge = makeJudge([
			judgedFinding(10, "X"),
			judgedFinding(11, "Y"),
		]);
		state.council.decisions.set(10, {
			findingId: 10,
			verdict: "endorse",
			decidedAt: "2026-01-01T00:20:00Z",
		});
		const text = formatFindingsView(state);
		expect(text).toMatch(/10[\s\S]*endorse/);
		expect(text).toMatch(/11[\s\S]*pending/);
	});

	it("shows edits inline so the user sees what gets posted, not just what the judge said", async () => {
		// "Edit" replaces subject/discussion before
		// promotion. The view must show the edited
		// version (with the original still visible so the
		// user remembers what changed).
		const state = createPrWorkflowState();
		state.council.lastJudge = makeJudge([
			judgedFinding(10, "Original subject"),
		]);
		state.council.decisions.set(10, {
			findingId: 10,
			verdict: "edit",
			subject: "Sharper subject",
			discussion: "Tighter discussion",
			decidedAt: "2026-01-01T00:20:00Z",
		});
		const text = formatFindingsView(state);
		expect(text).toContain("Sharper subject");
		expect(text).toContain("Tighter discussion");
		// Original retained for context
		expect(text).toContain("Original subject");
	});

	it("shows edited labels with the original retained for context", () => {
		const state = createPrWorkflowState();
		state.council.lastJudge = makeJudge([judgedFinding(10, "Subject")]);
		state.council.decisions.set(10, {
			findingId: 10,
			verdict: "edit",
			label: "nitpick",
			decidedAt: "2026-01-01T00:20:00Z",
		});
		const text = formatFindingsView(state);
		expect(text).toContain("[nitpick]");
		// Original label retained somewhere so the user
		// can see what they changed from.
		expect(text).toMatch(/original label:\s*issue/i);
	});

	it("appends a stack-level findings section when a cross-PR run is present", () => {
		// Stack findings render with an S-prefix on the
		// id (e.g. [S1]) so the user can pass scope=stack
		// when deciding. Home PR and spans show on the
		// header so the user knows where it'll post and
		// what it refers to.
		const state = createPrWorkflowState();
		state.council.lastJudge = makeJudge([judgedFinding(10, "per-pr")]);
		state.stackFindingRun = stackFindingRun([
			stackFinding(1, "inconsistent retries", 2, [1, 2, 3]),
		]);
		const text = formatFindingsView(state);
		expect(text).toContain("per-pr");
		expect(text).toContain("inconsistent retries");
		expect(text).toMatch(/S1|\[S-1\]|stack:.*\[1\]/);
		expect(text).toContain("#2");
		expect(text).toMatch(/1,\s*2,\s*3/);
	});

	it("shows stack critiques in the stack-level section", () => {
		const state = createPrWorkflowState();
		state.council.lastJudge = makeJudge([judgedFinding(10, "per-pr")]);
		state.stackFindingRun = {
			...stackFindingRun([stackFinding(1, "stacked", 1, [1, 2])]),
			critique: {
				id: "stack-critique",
				startedAt: "2026-01-01T00:10:00Z",
				judgeRunId: "stack-judge",
				reviewerOutputs: [
					{
						reviewerId: "fast",
						critiques: [
							{
								reviewerId: "fast",
								findingId: 1,
								position: "amplify",
								rationale: "stack impact is worse",
							},
						],
						warnings: [],
					},
				],
				warnings: [],
			},
		};
		const text = formatFindingsView(state);
		expect(text).toMatch(/stacked[\s\S]*critique \[fast\]: amplify/);
		expect(text).toContain("stack impact is worse");
	});

	it("shows stack decisions in the stack-level section", () => {
		const state = createPrWorkflowState();
		state.council.lastJudge = makeJudge([judgedFinding(10, "per-pr")]);
		state.stackFindingRun = stackFindingRun([
			stackFinding(1, "stacked", 1, [1, 2]),
		]);
		decideFinding(state, {
			findingId: 1,
			verdict: "endorse",
			scope: "stack",
		});
		const text = formatFindingsView(state);
		expect(text).toMatch(/stacked[\s\S]*decision:\s*endorse/);
	});

	it("renders without a stack section when stackFindingRun is null", () => {
		const state = createPrWorkflowState();
		state.council.lastJudge = makeJudge([judgedFinding(10, "per-pr")]);
		const text = formatFindingsView(state);
		expect(text).not.toMatch(/stack-level|cross-pr|stack finding/i);
	});

	it("returns a clear empty-state message when there's no judge run", async () => {
		const state = createPrWorkflowState();
		const text = formatFindingsView(state);
		expect(text).toMatch(/no findings|no judge|run.*council/i);
	});

	it("renders a 'fixed in <sha>' line when a fix has been recorded", () => {
		const state = createPrWorkflowState();
		state.council.lastJudge = makeJudge([judgedFinding(10, "Null deref")]);
		state.council.decisions.set(10, {
			findingId: 10,
			verdict: "fix",
			decidedAt: "2026-05-19T00:00:00Z",
			resolvedBy: {
				commitSha: "abc1234",
				recordedAt: "2026-05-19T00:05:00Z",
			},
		});
		const text = formatFindingsView(state);
		expect(text).toMatch(/fixed in abc1234/);
		expect(text).not.toMatch(/queued for fix/);
	});

	it("renders 'fix skipped' with the reason when a fix has been abandoned", () => {
		const state = createPrWorkflowState();
		state.council.lastJudge = makeJudge([judgedFinding(10, "Null deref")]);
		state.council.decisions.set(10, {
			findingId: 10,
			verdict: "fix",
			decidedAt: "2026-05-19T00:00:00Z",
			skipped: {
				reason: "actually fine",
				recordedAt: "2026-05-19T00:05:00Z",
			},
		});
		const text = formatFindingsView(state);
		expect(text).toMatch(/fix skipped — actually fine/);
	});
});

describe("decideFinding", () => {
	function withJudge() {
		const state = createPrWorkflowState();
		state.council.lastJudge = makeJudge([
			judgedFinding(10, "X"),
			judgedFinding(11, "Y"),
		]);
		return state;
	}

	it("records an endorse decision and surfaces it in state", async () => {
		const state = withJudge();
		const result = decideFinding(state, {
			findingId: 10,
			verdict: "endorse",
		});
		expect(result.ok).toBe(true);
		const decision = state.council.decisions.get(10);
		expect(decision?.verdict).toBe("endorse");
	});

	it("overrides a prior decision when the user changes their mind", async () => {
		const state = withJudge();
		decideFinding(state, { findingId: 10, verdict: "endorse" });
		decideFinding(state, {
			findingId: 10,
			verdict: "dismiss",
			reason: "duplicate of #99",
		});
		const decision = state.council.decisions.get(10);
		expect(decision?.verdict).toBe("dismiss");
		if (decision?.verdict === "dismiss") {
			expect(decision.reason).toBe("duplicate of #99");
		}
	});

	it("rejects a decision against an unknown findingId", async () => {
		const state = withJudge();
		const result = decideFinding(state, {
			findingId: 999,
			verdict: "endorse",
		});
		expect(expectFailure(result).error).toMatch(
			/unknown|no finding|not found/i,
		);
		expect(state.council.decisions.has(999)).toBe(false);
	});

	it("requires a note on qualify so 'keep but soften' has meaning", async () => {
		// Design 12: qualify carries content ("soften" /
		// "non-blocking"). An empty qualify is noise.
		const state = withJudge();
		const result = decideFinding(state, {
			findingId: 10,
			verdict: "qualify",
			note: "",
		});
		expect(expectFailure(result).error).toMatch(/note|qualify/i);
	});

	it("requires at least one of subject, discussion or label on edit", async () => {
		const state = withJudge();
		const result = decideFinding(state, {
			findingId: 10,
			verdict: "edit",
		});
		expect(expectFailure(result).error).toMatch(
			/subject|discussion|label|edit/i,
		);
	});

	it("accepts an edit decision that only overrides the label", async () => {
		// A user reclassifying an `issue` as a `nitpick`
		// shouldn't have to re-type the subject just to
		// keep validation happy. Label alone is enough.
		const state = withJudge();
		const result = decideFinding(state, {
			findingId: 10,
			verdict: "edit",
			label: "nitpick",
		});
		expect(result.ok).toBe(true);
		const decision = state.council.decisions.get(10);
		expect(decision?.verdict).toBe("edit");
		if (decision?.verdict === "edit") {
			expect(decision.label).toBe("nitpick");
			expect(decision.subject).toBeUndefined();
			expect(decision.discussion).toBeUndefined();
		}
	});

	it("records subject, discussion and label together when all three are edited", async () => {
		const state = withJudge();
		const result = decideFinding(state, {
			findingId: 10,
			verdict: "edit",
			subject: "Sharper",
			discussion: "Tighter",
			label: "suggestion",
		});
		expect(result.ok).toBe(true);
		const decision = state.council.decisions.get(10);
		if (decision?.verdict === "edit") {
			expect(decision.subject).toBe("Sharper");
			expect(decision.discussion).toBe("Tighter");
			expect(decision.label).toBe("suggestion");
		}
	});

	it("refuses to record decisions before a judge run exists — there's nothing to decide on", async () => {
		const state = createPrWorkflowState();
		const result = decideFinding(state, {
			findingId: 10,
			verdict: "endorse",
		});
		expect(expectFailure(result).error).toMatch(/judge|round 2|no findings/i);
	});

	it("stamps decidedAt with the injected clock", async () => {
		const state = withJudge();
		decideFinding(
			state,
			{ findingId: 10, verdict: "endorse" },
			() => new Date("2030-12-31T23:59:59Z"),
		);
		expect(state.council.decisions.get(10)?.decidedAt).toBe(
			"2030-12-31T23:59:59.000Z",
		);
	});

	describe("stack scope", () => {
		it("records a decision against a cross-PR finding into stackDecisions", () => {
			const state = createPrWorkflowState();
			state.stackFindingRun = stackFindingRun([
				stackFinding(1, "cross-pr", 2, [1, 2]),
			]);
			const result = decideFinding(state, {
				findingId: 1,
				verdict: "endorse",
				scope: "stack",
			});
			expect(result.ok).toBe(true);
			expect(state.stackDecisions.get(1)?.verdict).toBe("endorse");
			// Per-PR map is untouched.
			expect(state.council.decisions.size).toBe(0);
		});

		it("rejects scope=stack when no cross-PR run exists", () => {
			const state = createPrWorkflowState();
			const result = decideFinding(state, {
				findingId: 1,
				verdict: "endorse",
				scope: "stack",
			});
			expect(expectFailure(result).error).toMatch(/cross-PR|stack/i);
		});

		it("rejects scope=stack with unknown stack findingId", () => {
			const state = createPrWorkflowState();
			state.stackFindingRun = stackFindingRun([
				stackFinding(1, "x", 1, [1, 2]),
			]);
			const result = decideFinding(state, {
				findingId: 99,
				verdict: "endorse",
				scope: "stack",
			});
			expect(expectFailure(result).error).toMatch(/unknown|not in/i);
		});

		it("records a label-only edit against a stack finding", () => {
			const state = createPrWorkflowState();
			state.stackFindingRun = stackFindingRun([
				stackFinding(1, "cross-pr", 2, [1, 2]),
			]);
			const result = decideFinding(state, {
				findingId: 1,
				verdict: "edit",
				label: "suggestion",
				scope: "stack",
			});
			expect(result.ok).toBe(true);
			const decision = state.stackDecisions.get(1);
			if (decision?.verdict === "edit") {
				expect(decision.label).toBe("suggestion");
			}
		});

		it("stack decisions are independent from per-PR decisions on the same id", () => {
			// findingId 1 can exist as both a per-PR finding
			// and a stack finding without collision.
			const state = createPrWorkflowState();
			state.council.lastJudge = makeJudge([judgedFinding(1, "per-pr")]);
			state.stackFindingRun = stackFindingRun([
				stackFinding(1, "stack", 1, [1, 2]),
			]);

			decideFinding(state, { findingId: 1, verdict: "endorse" });
			decideFinding(state, {
				findingId: 1,
				verdict: "dismiss",
				reason: "covered elsewhere",
				scope: "stack",
			});

			expect(state.council.decisions.get(1)?.verdict).toBe("endorse");
			expect(state.stackDecisions.get(1)?.verdict).toBe("dismiss");
		});
	});
});

describe("integration: critique + decisions flow", () => {
	it("a typical run renders judge + dissent + decisions consistently", async () => {
		const state = createPrWorkflowState();
		state.council.lastRun = {
			id: "c-1",
			startedAt: "2026-01-01T00:00:00Z",
			target: { kind: "diff", prNumber: 42 },
			reviewerOutputs: [],
		} satisfies CouncilRun;
		state.council.lastJudge = makeJudge([
			judgedFinding(10, "Crash on null"),
			judgedFinding(11, "Style nit"),
		]);
		state.council.lastCritique = {
			id: "critique-1",
			startedAt: "2026-01-01T00:10:00Z",
			judgeRunId: "j-1",
			reviewerOutputs: [
				{
					reviewerId: "fast",
					critiques: [
						{
							reviewerId: "fast",
							findingId: 10,
							position: "agree",
							rationale: "confirmed",
						},
						{
							reviewerId: "fast",
							findingId: 11,
							position: "disagree",
							rationale: "matches existing style",
						},
					],
					warnings: [],
				},
			],
			warnings: [],
		};

		decideFinding(state, { findingId: 10, verdict: "endorse" });
		decideFinding(state, {
			findingId: 11,
			verdict: "dismiss",
			reason: "disagreement is correct",
		});

		const text = formatFindingsView(state);
		expect(text).toContain("Crash on null");
		expect(text).toContain("Style nit");
		expect(text).toContain("endorse");
		expect(text).toContain("dismiss");
		expect(text).toContain("disagreement is correct");
	});
});

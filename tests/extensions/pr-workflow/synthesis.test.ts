import { describe, expect, it } from "vitest";
import type { CritiqueRun } from "../../../extensions/pr-workflow/critique.js";
import type {
	CouncilRun,
	Finding,
} from "../../../extensions/pr-workflow/findings.js";
import type { JudgeRun } from "../../../extensions/pr-workflow/judge.js";
import { createPrWorkflowState } from "../../../extensions/pr-workflow/state.js";
import {
	decideFinding,
	type FindingDecision,
	formatFindingsView,
} from "../../../extensions/pr-workflow/synthesis.js";

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

	it("returns a clear empty-state message when there's no judge run", async () => {
		const state = createPrWorkflowState();
		const text = formatFindingsView(state);
		expect(text).toMatch(/no findings|no judge|run.*council/i);
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
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/unknown|no finding|not found/i);
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
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/note|qualify/i);
	});

	it("requires at least one of subject/discussion on edit", async () => {
		const state = withJudge();
		const result = decideFinding(state, {
			findingId: 10,
			verdict: "edit",
		});
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/subject|discussion|edit/i);
	});

	it("refuses to record decisions before a judge run exists — there's nothing to decide on", async () => {
		const state = createPrWorkflowState();
		const result = decideFinding(state, {
			findingId: 10,
			verdict: "endorse",
		});
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/judge|round 2|no findings/i);
	});

	it("stamps decidedAt with the injected clock", async () => {
		const state = withJudge();
		decideFinding(
			state,
			{ findingId: 10, verdict: "endorse" } as Omit<
				FindingDecision,
				"decidedAt"
			>,
			() => new Date("2030-12-31T23:59:59Z"),
		);
		expect(state.council.decisions.get(10)?.decidedAt).toBe(
			"2030-12-31T23:59:59.000Z",
		);
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

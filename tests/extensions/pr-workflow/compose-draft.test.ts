/**
 * Composing the decided review as a substrate draft.
 *
 * The draft is the composition unit: what this review will say,
 * once the deliberating is over. The council runs, the critiques
 * and the verdicts that produced it stay where they are, because
 * they are the record of deciding, not the thing decided.
 *
 * Which remarks land inline and which spill into the body is
 * deliberately not settled here. That is the plan's judgment,
 * made against a provider's actual capabilities.
 */

import { describe, expect, it } from "vitest";
import type { Finding } from "../../../extensions/pr-workflow/findings.js";
import type { JudgeRun } from "../../../extensions/pr-workflow/judge.js";
import { composeDraft } from "../../../extensions/pr-workflow/post.js";
import type {
	StackFinding,
	StackFindingRun,
} from "../../../extensions/pr-workflow/stack-findings.js";
import { createPrWorkflowState } from "../../../extensions/pr-workflow/state.js";
import { prMetadata } from "./fixtures.js";

function lineFinding(id: number, overrides: Partial<Finding> = {}): Finding {
	return {
		id,
		location: {
			kind: "line",
			file: "lib/x.ts",
			start: 10,
			end: 12,
			side: "new",
		},
		label: "issue",
		decorations: [],
		subject: `subject ${id}`,
		discussion: `discussion ${id}`,
		category: "file",
		origin: { kind: "judge", runId: "j-1", judgeReviewerId: "j" },
		state: "draft",
		...overrides,
	};
}

function stackFinding(id: number, homePrNumber: number): StackFinding {
	return {
		id,
		location: { kind: "global" },
		label: "issue",
		decorations: [],
		subject: `stack subject ${id}`,
		discussion: `stack discussion ${id}`,
		category: "scope",
		origin: { kind: "cross-PR", runId: "sc-1", reviewerId: "sc" },
		state: "draft",
		homePrNumber,
		spans: [homePrNumber],
	};
}

function stackRun(findings: StackFinding[]): StackFindingRun {
	return {
		id: "sc-1",
		startedAt: "x",
		reviewerId: "sc",
		findings,
		warnings: [],
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

function stateWith(
	findings: Finding[],
): ReturnType<typeof createPrWorkflowState> {
	const state = createPrWorkflowState();
	state.pr = {
		reference: { owner: "o", repo: "r", number: 42 },
		loadedAt: "x",
		metadata: prMetadata({}),
		files: [],
		threads: [],
		fixes: new Map(),
	} as unknown as (typeof state)["pr"];
	state.council.lastJudge = judge(findings);
	return state;
}

function decide(
	state: ReturnType<typeof createPrWorkflowState>,
	id: number,
	verdict: "endorse" | "dismiss" | "fix" | "promote",
): void {
	state.council.decisions.set(id, { findingId: id, verdict, decidedAt: "x" });
}

describe("composeDraft", () => {
	it("carries a decided finding across as an anchored item", () => {
		const state = stateWith([lineFinding(10)]);
		decide(state, 10, "endorse");

		const draft = composeDraft(state, "COMMENT");

		expect(draft.items).toHaveLength(1);
		const item = draft.items[0];
		expect(item.kind).toBe("finding");
		if (item.kind !== "finding") return;
		expect(item.anchor).toEqual({
			subject: "line",
			path: "lib/x.ts",
			blob: "new",
			line: 12,
			startLine: 10,
		});
		expect(item.body).toContain("subject 10");
	});

	it("leaves out what the reviewer dismissed or queued for a fix", () => {
		// Neither is going to be said out loud, and a draft is what
		// will be said.
		const state = stateWith([
			lineFinding(10),
			lineFinding(11),
			lineFinding(12),
		]);
		decide(state, 10, "endorse");
		decide(state, 11, "dismiss");
		decide(state, 12, "fix");

		expect(composeDraft(state, "COMMENT").items).toHaveLength(1);
	});

	it("leaves out a finding nobody has decided yet", () => {
		const state = stateWith([lineFinding(10)]);

		expect(composeDraft(state, "COMMENT").items).toEqual([]);
	});

	it("says the verdict in the contract's vocabulary", () => {
		const state = stateWith([]);

		expect(composeDraft(state, "APPROVE").verdict).toBe("approve");
		expect(composeDraft(state, "REQUEST_CHANGES").verdict).toBe(
			"request-changes",
		);
		expect(composeDraft(state, "COMMENT").verdict).toBe("comment");
	});

	it("anchors a file-level finding to the file, not to a line", () => {
		const state = stateWith([
			lineFinding(10, { location: { kind: "file", file: "README.md" } }),
		]);
		decide(state, 10, "endorse");

		const item = composeDraft(state, "COMMENT").items[0];
		if (item.kind !== "finding") throw new Error("expected a finding");
		expect(item.anchor).toEqual({ subject: "file", path: "README.md" });
	});

	it("says a change-wide remark is about the change, not about a file", () => {
		// A finding about the title or the scope still has to be said,
		// so dropping it would lose it silently. Naming a file it does
		// not have would make the plan spill it for a made-up reason.
		const state = stateWith([
			lineFinding(10, { location: { kind: "global" } }),
		]);
		decide(state, 10, "endorse");

		const item = composeDraft(state, "COMMENT").items[0];
		if (item.kind !== "finding") throw new Error("expected a finding");
		expect(item.anchor).toEqual({ subject: "change" });
	});

	it("composes a cross-PR remark that homes to this change", () => {
		// A stack review says things about the change in front of you
		// as well as about its neighbours. Leaving those out would
		// post half a review and call it whole.
		const state = stateWith([]);
		state.stackFindingRun = stackRun([stackFinding(20, 42)]);
		state.stackDecisions.set(20, {
			findingId: 20,
			verdict: "endorse",
			decidedAt: "x",
		});

		const items = composeDraft(state, "COMMENT").items;
		expect(items).toHaveLength(1);
		const item = items[0];
		if (item.kind !== "finding") throw new Error("expected a finding");
		expect(item.body).toContain("stack subject 20");
	});

	it("leaves out a cross-PR remark that belongs to another change", () => {
		// It homes elsewhere, so it gets posted there. Saying it here
		// too would double it.
		const state = stateWith([]);
		state.stackFindingRun = stackRun([stackFinding(20, 99)]);
		state.stackDecisions.set(20, {
			findingId: 20,
			verdict: "endorse",
			decidedAt: "x",
		});

		expect(composeDraft(state, "COMMENT").items).toEqual([]);
	});

	it("anchors a cross-PR remark to the change, since it spans several", () => {
		const state = stateWith([]);
		state.stackFindingRun = stackRun([stackFinding(20, 42)]);
		state.stackDecisions.set(20, {
			findingId: 20,
			verdict: "endorse",
			decidedAt: "x",
		});

		const item = composeDraft(state, "COMMENT").items[0];
		if (item.kind !== "finding") throw new Error("expected a finding");
		expect(item.anchor).toEqual({ subject: "change" });
	});

	it("hands every item a distinct id, so the plan can report on one", () => {
		const state = stateWith([lineFinding(10), lineFinding(11)]);
		decide(state, 10, "endorse");
		decide(state, 11, "promote");

		const ids = composeDraft(state, "COMMENT").items.map((item) => item.id);
		expect(new Set(ids).size).toBe(2);
	});
});

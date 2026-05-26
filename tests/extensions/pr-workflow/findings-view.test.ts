import { describe, expect, it } from "vitest";
import type { Finding } from "../../../extensions/pr-workflow/findings.js";
import {
	formatCompactFindingsView,
	verdictMarker,
} from "../../../extensions/pr-workflow/findings-view.js";
import type { JudgeRun } from "../../../extensions/pr-workflow/judge.js";
import {
	createPrWorkflowState,
	type PrWorkflowState,
} from "../../../extensions/pr-workflow/state.js";
import { decideFinding } from "../../../extensions/pr-workflow/synthesis.js";

function loadedState(): PrWorkflowState {
	const state = createPrWorkflowState();
	state.active = true;
	state.pr = {
		reference: { owner: "shopify", repo: "world", number: 1234 },
		loadedAt: "2026-05-19T00:00:00Z",
		metadata: null,
		files: null,
		stack: null,
	};
	return state;
}

function lineFinding(id: number, subject: string): Finding {
	return {
		id,
		location: { kind: "line", file: "a.ts", start: 12, end: 14, side: "new" },
		label: "issue",
		decorations: [],
		subject,
		discussion: "details",
		category: "scope",
		origin: { kind: "judge", runId: "j-1", judgeReviewerId: "j" },
		state: "draft",
		agreement: { raisedBy: ["fast"], sourceFindingIds: [] },
	};
}

function judgeWith(findings: Finding[]): JudgeRun {
	return {
		id: "j-1",
		startedAt: "2026-01-01T00:00:00Z",
		judgeReviewerId: "j",
		selfSignal: null,
		consolidatedFindings: findings,
		warnings: [],
	};
}

describe("verdictMarker", () => {
	it("renders · when no decision has been recorded", () => {
		expect(verdictMarker(null)).toBe("·");
	});

	it("renders + for endorse", () => {
		expect(
			verdictMarker({ findingId: 1, verdict: "endorse", decidedAt: "now" }),
		).toBe("+");
	});

	it("renders * for queued fix (no resolution yet)", () => {
		expect(
			verdictMarker({ findingId: 1, verdict: "fix", decidedAt: "now" }),
		).toBe("*");
	});

	it("renders ✓ for committed fix", () => {
		expect(
			verdictMarker({
				findingId: 1,
				verdict: "fix",
				decidedAt: "now",
				resolvedBy: { commitSha: "abc1234", recordedAt: "now" },
			}),
		).toBe("✓");
	});

	it("renders — for skipped fix", () => {
		expect(
			verdictMarker({
				findingId: 1,
				verdict: "fix",
				decidedAt: "now",
				skipped: { reason: "blocked", recordedAt: "now" },
			}),
		).toBe("—");
	});
});

describe("formatCompactFindingsView", () => {
	it("hints to run council/judge when nothing has happened", () => {
		const text = formatCompactFindingsView(createPrWorkflowState());
		expect(text).toContain("Run pr_workflow");
	});

	it("renders one row per finding with id, marker, label and location", () => {
		const state = loadedState();
		state.council.lastJudge = judgeWith([
			lineFinding(1, "first"),
			lineFinding(2, "second"),
		]);
		const text = formatCompactFindingsView(state);
		expect(text).toContain("[1] · [issue] first (a.ts:12-14)");
		expect(text).toContain("[2] · [issue] second (a.ts:12-14)");
	});

	it("reflects edited subject in the row when an edit decision exists", () => {
		const state = loadedState();
		state.council.lastJudge = judgeWith([lineFinding(1, "original")]);
		decideFinding(state, {
			findingId: 1,
			verdict: "edit",
			subject: "new subject",
		});
		const text = formatCompactFindingsView(state);
		expect(text).toContain("new subject");
		expect(text).not.toContain("[1] · [issue] original");
	});

	it("reflects an edited label in the row", () => {
		const state = loadedState();
		state.council.lastJudge = judgeWith([lineFinding(1, "subject")]);
		decideFinding(state, {
			findingId: 1,
			verdict: "edit",
			label: "nitpick",
		});
		const text = formatCompactFindingsView(state);
		expect(text).toContain("[nitpick]");
		expect(text).not.toContain("[issue]");
	});

	it("includes a legend and pointer to verbose mode", () => {
		const state = loadedState();
		state.council.lastJudge = judgeWith([lineFinding(1, "x")]);
		const text = formatCompactFindingsView(state);
		expect(text).toContain("Legend:");
		expect(text).toContain("verbose:true");
	});
});

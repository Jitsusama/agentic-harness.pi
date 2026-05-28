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
import type { DiffFile } from "../../../lib/internal/github/diff.js";

function diffFile(path: string, newStart: number, newEnd: number): DiffFile {
	const lines = Array.from({ length: newEnd - newStart + 1 }, (_, offset) => ({
		type: "context" as const,
		content: "x",
		oldLineNumber: newStart + offset,
		newLineNumber: newStart + offset,
	}));
	return {
		path,
		status: "modified",
		additions: 1,
		deletions: 0,
		hunks: [
			{
				header: `@@ -${newStart},${lines.length} +${newStart},${lines.length} @@`,
				oldStart: newStart,
				oldCount: lines.length,
				newStart,
				newCount: lines.length,
				lines,
			},
		],
	};
}

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

	function withDiff(state: PrWorkflowState, file: DiffFile): void {
		if (state.pr === null) throw new Error("loadedState should populate pr");
		state.pr = { ...state.pr, files: [file] };
	}

	it("marks a line-kind finding whose lines fall outside the diff hunks as body-bound", () => {
		// Finding points at lines 12-14 of a.ts. Diff only
		// touches lines 100-110, so this finding would
		// silently degrade to a body comment at post time;
		// the user needs to see that at decide time.
		const state = loadedState();
		withDiff(state, diffFile("a.ts", 100, 110));
		state.council.lastJudge = judgeWith([lineFinding(1, "off-diff")]);
		const text = formatCompactFindingsView(state);
		expect(text).toContain("→body");
	});

	it("does not mark a line-kind finding whose anchor matches the diff", () => {
		const state = loadedState();
		withDiff(state, diffFile("a.ts", 10, 20));
		state.council.lastJudge = judgeWith([lineFinding(1, "on-diff")]);
		const text = formatCompactFindingsView(state);
		expect(text).not.toContain("→body");
	});

	it("renders a critique summary when non-agree positions exist", () => {
		// `verbose:true` shows the full critique entries.
		// In the compact view we only surface the counts so
		// the user knows pushback exists without scrolling.
		const state = loadedState();
		state.council.lastJudge = judgeWith([lineFinding(1, "x")]);
		state.council.lastCritique = {
			id: "crit-1",
			startedAt: "now",
			judgeRunId: "j-1",
			reviewerOutputs: [
				{
					reviewerId: "opus",
					warnings: [],
					critiques: [
						{
							reviewerId: "opus",
							findingId: 1,
							position: "disagree",
							rationale: "r",
						},
					],
				},
				{
					reviewerId: "gpt",
					warnings: [],
					critiques: [
						{
							reviewerId: "gpt",
							findingId: 1,
							position: "agree",
							rationale: "r",
						},
					],
				},
			],
		};
		const text = formatCompactFindingsView(state);
		expect(text).toContain("crit: 1 agree, 1 disagree");
	});

	it("hides the critique summary when every position is agree", () => {
		const state = loadedState();
		state.council.lastJudge = judgeWith([lineFinding(1, "x")]);
		state.council.lastCritique = {
			id: "crit-1",
			startedAt: "now",
			judgeRunId: "j-1",
			reviewerOutputs: [
				{
					reviewerId: "opus",
					warnings: [],
					critiques: [
						{
							reviewerId: "opus",
							findingId: 1,
							position: "agree",
							rationale: "r",
						},
					],
				},
			],
		};
		const text = formatCompactFindingsView(state);
		expect(text).not.toContain("crit:");
	});

	it("renders the skip reason inline next to a fix-skipped finding", () => {
		// Without this, users see the — marker and have to
		// dig through verbose:true to learn why the fix was
		// abandoned. Surface the reason in the same row.
		const state = loadedState();
		state.council.lastJudge = judgeWith([lineFinding(1, "deferred")]);
		decideFinding(state, {
			findingId: 1,
			verdict: "fix",
		});
		const decision = state.council.decisions.get(1);
		if (!decision || decision.verdict !== "fix") {
			throw new Error("setup: expected fix decision");
		}
		state.council.decisions.set(1, {
			...decision,
			skipped: { reason: "applied in main checkout", recordedAt: "now" },
		});
		const text = formatCompactFindingsView(state);
		expect(text).toContain("— note: applied in main checkout");
	});

	it("omits the marker for file-kind findings (those are body-bound by nature)", () => {
		const state = loadedState();
		withDiff(state, diffFile("a.ts", 10, 20));
		const fileFinding: Finding = {
			...lineFinding(1, "file scope"),
			location: { kind: "file", file: "a.ts" },
		};
		state.council.lastJudge = judgeWith([fileFinding]);
		const text = formatCompactFindingsView(state);
		expect(text).not.toContain("→body");
	});

	it("reflects an edited location when checking anchorability", () => {
		// User edits the location to point at the actual
		// diff hunks; the marker should disappear.
		const state = loadedState();
		withDiff(state, diffFile("a.ts", 100, 110));
		state.council.lastJudge = judgeWith([lineFinding(1, "orig")]);
		decideFinding(state, {
			findingId: 1,
			verdict: "edit",
			start: 105,
			end: 105,
		});
		const text = formatCompactFindingsView(state);
		expect(text).not.toContain("→body");
	});
});

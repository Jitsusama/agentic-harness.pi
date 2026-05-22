/**
 * Tests for stack-wide review prompt and parser primitives. These are pure data-layer tests: no pi
 * subprocess, no worktree, no state mutation.
 */

import { describe, expect, it } from "vitest";
import type { Finding } from "../../../extensions/pr-workflow/findings.js";
import type { StackFinding } from "../../../extensions/pr-workflow/stack-findings.js";
import {
	buildStackJudgePrompt,
	buildStackReviewPrompt,
	parseStackJudgeOutput,
	parseStackReviewOutput,
	type StackReviewerOutput,
} from "../../../extensions/pr-workflow/stack-review.js";
import { diffHunk, diffLine } from "./fixtures.js";

function jsonBlock(value: unknown): string {
	return ["```json", JSON.stringify(value), "```"].join("\n");
}

function finding(id: number, subject = `finding ${id}`): Finding {
	return {
		id,
		location: { kind: "global" },
		label: "issue",
		decorations: [],
		subject,
		discussion: "details",
		category: "scope",
		origin: { kind: "stack-review", runId: "stack", reviewerId: "fast" },
		state: "draft",
	};
}

function stackFinding(id: number): StackFinding {
	return {
		...finding(id, "cross finding"),
		homePrNumber: 101,
		spans: [101, 102],
	};
}

describe("buildStackReviewPrompt", () => {
	it("renders each PR as a separate section and names the stack-review verifier stage", () => {
		const prompt = buildStackReviewPrompt({
			cursorPrNumber: 102,
			prs: [
				{
					prNumber: 101,
					title: "Add parser",
					description: "First PR",
					files: [
						{
							path: "parser.ts",
							status: "modified",
							additions: 1,
							deletions: 0,
							hunks: [
								diffHunk({
									lines: [diffLine({ type: "added", content: "parse()" })],
								}),
							],
						},
					],
				},
				{ prNumber: 102, title: "Wire parser", description: "", files: [] },
			],
		});
		expect(prompt).toContain("### PR #101: Add parser");
		expect(prompt).toContain("### PR #102 [cursor]: Wire parser");
		expect(prompt).toContain("+parse()");
		expect(prompt).toContain('stage: "stack-review"');
		expect(prompt).toContain("perPr");
		expect(prompt).toContain("crossPr");
	});

	it("instructs stack reviewer tools to stay inside the worktree", () => {
		const prompt = buildStackReviewPrompt({
			cursorPrNumber: 102,
			prs: [
				{ prNumber: 102, title: "Wire parser", description: "", files: [] },
			],
		});
		expect(prompt).toContain("current working directory");
		expect(prompt).toContain("Stay inside");
		expect(prompt).toContain("Do not search `/`");
		expect(prompt).toContain("`/Users`");
		expect(prompt).toContain("`$HOME`");
		expect(prompt).toContain("Never run commands like `find /`");
		expect(prompt).toContain("Do not roam the filesystem");
		expect(prompt).toContain("`rg`");
	});

	it("instructs stack reviewers to load relevant review and quality skills generically", () => {
		const prompt = buildStackReviewPrompt({
			cursorPrNumber: 102,
			prs: [
				{ prNumber: 102, title: "Wire parser", description: "", files: [] },
			],
		});
		expect(prompt).toContain("Pi skills");
		expect(prompt).toContain("project-level");
		expect(prompt).toContain("user-level");
		expect(prompt).toContain("SKILL.md");
		expect(prompt).toContain("code review");
		expect(prompt).toContain("code quality");
		expect(prompt).not.toContain("code-review-standard");
		expect(prompt).not.toContain("comment-format");
	});

	it("defines stack review quality and cross-PR discovery criteria", () => {
		const prompt = buildStackReviewPrompt({
			cursorPrNumber: 102,
			prs: [
				{ prNumber: 102, title: "Wire parser", description: "", files: [] },
			],
		});
		expect(prompt).toContain("Review quality standard");
		expect(prompt).toContain("Stack-specific discovery objective");
		expect(prompt).toContain("sequencing problems");
		expect(prompt).toContain("hidden dependencies between PRs");
		expect(prompt).toContain("Use cross-PR findings only when");
		expect(prompt).toContain("where the comment is most actionable");
	});
});

describe("parseStackReviewOutput", () => {
	it("parses per-PR and cross-PR findings with one monotonic id space", () => {
		const result = parseStackReviewOutput(
			jsonBlock({
				perPr: {
					"101": [
						{
							location: { kind: "global" },
							label: "issue",
							subject: "per pr one",
							discussion: "d1",
						},
					],
					"102": [
						{
							location: { kind: "file", file: "wire.ts" },
							label: "suggestion",
							subject: "per pr two",
							discussion: "d2",
						},
					],
				},
				crossPr: [
					{
						location: { kind: "global" },
						label: "issue",
						subject: "cross",
						discussion: "cross details",
						homePrNumber: 101,
						spans: [101, 102],
					},
				],
			}),
			{ runId: "stack-run", reviewerId: "fast", startId: 10 },
		);
		expect(result.warnings).toEqual([]);
		expect(result.perPr.get(101)?.[0]?.id).toBe(10);
		expect(result.perPr.get(102)?.[0]?.id).toBe(11);
		expect(result.crossPr[0]?.id).toBe(12);
		expect(result.crossPr[0]?.homePrNumber).toBe(101);
		expect(result.crossPr[0]?.origin).toMatchObject({
			kind: "stack-review",
			runId: "stack-run",
			reviewerId: "fast",
		});
	});

	it("warns and skips malformed perPr keys and findings", () => {
		const result = parseStackReviewOutput(
			jsonBlock({
				perPr: {
					main: [],
					"101": [
						{ location: { kind: "global" }, label: "issue", subject: "" },
					],
				},
				crossPr: [],
			}),
			{ runId: "stack-run", reviewerId: "fast", startId: 1 },
		);
		expect(result.perPr.has(101)).toBe(true);
		expect(result.perPr.get(101)).toEqual([]);
		expect(result.warnings).toEqual(
			expect.arrayContaining([
				expect.stringContaining('perPr key "main"'),
				expect.stringContaining("finding at index 0 is malformed"),
			]),
		);
	});
});

describe("buildStackJudgePrompt", () => {
	it("renders reviewer per-PR and cross-PR findings and names stack-judge", () => {
		const reviewer: StackReviewerOutput = {
			reviewerId: "fast",
			perPr: new Map([[101, [finding(1, "per-pr issue")]]]),
			crossPr: [stackFinding(2)],
			warnings: [],
		};
		const prompt = buildStackJudgePrompt({
			cursorPrNumber: 101,
			prs: [{ prNumber: 101, title: "Add parser" }],
			reviewerOutputs: [reviewer],
		});
		expect(prompt).toContain("Reviewer fast");
		expect(prompt).toContain("PR #101:");
		expect(prompt).toContain("per-pr issue");
		expect(prompt).toContain("homePrNumber=101; spans=101, 102");
		expect(prompt).toContain('stage: "stack-judge"');
	});

	it("instructs stack judge tools to stay inside the worktree", async () => {
		const prompt = buildStackJudgePrompt({
			cursorPrNumber: 101,
			prs: [{ prNumber: 101, title: "Add parser" }],
			reviewerOutputs: [
				{ reviewerId: "fast", perPr: new Map(), crossPr: [], warnings: [] },
			],
		});
		expect(prompt).toContain("current working directory");
		expect(prompt).toContain("Stay inside");
		expect(prompt).toContain("Do not search `/`");
		expect(prompt).toContain("`/Users`");
		expect(prompt).toContain("`$HOME`");
		expect(prompt).toContain("Never run commands like `find /`");
		expect(prompt).toContain("Do not roam the filesystem");
		expect(prompt).toContain("`rg`");
	});

	it("instructs stack judges to load relevant review and quality skills generically", async () => {
		const prompt = buildStackJudgePrompt({
			cursorPrNumber: 101,
			prs: [{ prNumber: 101, title: "Add parser" }],
			reviewerOutputs: [
				{ reviewerId: "fast", perPr: new Map(), crossPr: [], warnings: [] },
			],
		});
		expect(prompt).toContain("Pi skills");
		expect(prompt).toContain("project-level");
		expect(prompt).toContain("user-level");
		expect(prompt).toContain("SKILL.md");
		expect(prompt).toContain("code review");
		expect(prompt).toContain("code quality");
		expect(prompt).not.toContain("code-review-standard");
		expect(prompt).not.toContain("comment-format");
	});

	it("defines stack judge curation without losing PR topology", async () => {
		const prompt = buildStackJudgePrompt({
			cursorPrNumber: 101,
			prs: [{ prNumber: 101, title: "Add parser" }],
			reviewerOutputs: [
				{ reviewerId: "fast", perPr: new Map(), crossPr: [], warnings: [] },
			],
		});
		expect(prompt).toContain("Judge synthesis objective");
		expect(prompt).toContain("Stack-specific synthesis objective");
		expect(prompt).toContain("Preserve the stack topology");
		expect(prompt).toContain("do not duplicate the same conceptual issue");
		expect(prompt).toContain("Assign `homePrNumber`");
	});
});

describe("parseStackJudgeOutput", () => {
	it("parses self-signal, per-PR findings, cross-PR findings and agreement", () => {
		const result = parseStackJudgeOutput(
			jsonBlock({
				selfSignal: { confidence: "high", rationale: "reviewers agree" },
				perPr: {
					"101": [
						{
							location: { kind: "global" },
							label: "issue",
							subject: "consolidated",
							discussion: "details",
							raisedBy: ["fast"],
							sourceFindingIds: [1],
						},
					],
				},
				crossPr: [
					{
						location: { kind: "global" },
						label: "issue",
						subject: "cross consolidated",
						discussion: "cross details",
						homePrNumber: 101,
						spans: [101, 102],
						raisedBy: ["fast", "skeptic"],
						sourceFindingIds: [2, 3],
					},
				],
			}),
			{ runId: "judge-run", judgeReviewerId: "judge", startId: 20 },
		);
		expect(result.selfSignal?.confidence).toBe("high");
		expect(result.perPr.get(101)?.[0]?.id).toBe(20);
		expect(result.perPr.get(101)?.[0]?.agreement).toEqual({
			raisedBy: ["fast"],
			sourceFindingIds: [1],
		});
		expect(result.crossPr[0]?.id).toBe(21);
		expect(result.crossPr[0]?.agreement).toEqual({
			raisedBy: ["fast", "skeptic"],
			sourceFindingIds: [2, 3],
		});
		expect(result.crossPr[0]?.origin).toMatchObject({
			kind: "stack-judge",
			runId: "judge-run",
			judgeReviewerId: "judge",
		});
	});
});

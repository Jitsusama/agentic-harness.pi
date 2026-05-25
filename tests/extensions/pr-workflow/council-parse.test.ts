import { describe, expect, it } from "vitest";
import { parseReviewerOutput } from "../../../extensions/pr-workflow/parse.js";

/**
 * Reviewers return findings as JSON. Real LLM output is
 * messy: extra prose around the JSON, fenced code blocks,
 * incidental formatting. The parser tolerates these and
 * surfaces a `warnings` list rather than throwing so a
 * single bad finding doesn't kill the whole round.
 */

const FIRST_ID = 100;

describe("parseReviewerOutput", () => {
	it("parses a well-formed JSON object with one finding", () => {
		const text = JSON.stringify({
			findings: [
				{
					location: {
						kind: "line",
						file: "src/foo.ts",
						start: 10,
						end: 12,
						side: "new",
					},
					label: "issue",
					decorations: ["blocking"],
					subject: "Null pointer risk",
					discussion: "The handler can receive null when X happens.",
					severity: "critical",
					confidence: 0.9,
					threadRelation: {
						kind: "supports-existing",
						threadIndex: 2,
						rationale: "Matches the existing auth thread.",
					},
				},
			],
		});
		const result = parseReviewerOutput(text, {
			reviewerId: "r1",
			runId: "run-1",
			startId: FIRST_ID,
		});
		expect(result.warnings).toEqual([]);
		expect(result.findings).toHaveLength(1);
		const f = result.findings[0];
		expect(f.id).toBe(FIRST_ID);
		expect(f.subject).toBe("Null pointer risk");
		expect(f.label).toBe("issue");
		expect(f.severity).toBe("critical");
		expect(f.threadRelation).toEqual({
			kind: "supports-existing",
			threadIndex: 2,
			rationale: "Matches the existing auth thread.",
		});
		expect(f.location).toEqual({
			kind: "line",
			file: "src/foo.ts",
			start: 10,
			end: 12,
			side: "new",
		});
		expect(f.origin).toEqual({
			kind: "council",
			runId: "run-1",
			reviewerId: "r1",
		});
		expect(f.state).toBe("draft");
	});

	it("extracts JSON wrapped in a fenced code block", () => {
		// Real models often surround JSON with explanatory
		// prose. The parser must find the first
		// ```json ... ``` block and use it.
		const text = [
			"Here is my review:",
			"",
			"```json",
			JSON.stringify({ findings: [] }),
			"```",
			"",
			"Let me know if you'd like more.",
		].join("\n");
		const result = parseReviewerOutput(text, {
			reviewerId: "r1",
			runId: "run-1",
			startId: 1,
		});
		expect(result.findings).toEqual([]);
		expect(result.warnings).toEqual([]);
	});

	it("parses canonical plain JSON whose strings contain nested json fences", () => {
		const text = JSON.stringify({
			findings: [
				{
					location: { kind: "global" },
					label: "issue",
					subject: "Nested json fence",
					discussion: 'This mentions ```json {"x":1} ``` inside JSON.',
				},
			],
		});

		const result = parseReviewerOutput(text, {
			reviewerId: "r1",
			runId: "run-1",
			startId: 1,
		});

		expect(result.warnings).toEqual([]);
		expect(result.findings).toHaveLength(1);
		expect(result.findings[0].discussion).toContain("```json");
	});

	it("parses fenced JSON whose strings contain nested code fences", () => {
		const text = [
			"```json",
			JSON.stringify({
				findings: [
					{
						location: { kind: "global" },
						label: "issue",
						subject: "Nested fence",
						discussion: "This mentions ```inside``` the JSON string.",
					},
				],
			}),
			"```",
		].join("\n");

		const result = parseReviewerOutput(text, {
			reviewerId: "r1",
			runId: "run-1",
			startId: 1,
		});

		expect(result.warnings).toEqual([]);
		expect(result.findings).toHaveLength(1);
		expect(result.findings[0].discussion).toContain("```inside```");
	});

	it("issues sequential ids starting from startId", () => {
		// The session keeps a monotonic id sequence so
		// findings can be referenced by number later. The
		// parser allocates from the caller's cursor.
		const text = JSON.stringify({
			findings: [
				{
					location: { kind: "global" },
					label: "praise",
					subject: "Nice rename",
					discussion: "The variable name is clearer now.",
				},
				{
					location: { kind: "file", file: "src/foo.ts" },
					label: "nitpick",
					subject: "Whitespace",
					discussion: "Trailing blank line.",
				},
			],
		});
		const result = parseReviewerOutput(text, {
			reviewerId: "r1",
			runId: "run-1",
			startId: 7,
		});
		expect(result.findings.map((f) => f.id)).toEqual([7, 8]);
	});

	it("returns an empty list and a warning when JSON is missing", () => {
		// A model that returns prose only gets caught here.
		// The caller decides what to do with the warning;
		// we don't throw because one rogue reviewer must
		// not abort the whole round.
		const result = parseReviewerOutput(
			"I reviewed but found nothing worth flagging.",
			{ reviewerId: "r1", runId: "run-1", startId: 1 },
		);
		expect(result.findings).toEqual([]);
		expect(result.warnings.length).toBeGreaterThan(0);
		expect(result.warnings[0].toLowerCase()).toMatch(/json/);
	});

	it("returns an empty list and a warning on invalid JSON", () => {
		// Truncated or malformed JSON yields a warning but
		// not a crash. The caller surfaces it to the user.
		const result = parseReviewerOutput("```json\n{ findings: [\n```", {
			reviewerId: "r1",
			runId: "run-1",
			startId: 1,
		});
		expect(result.findings).toEqual([]);
		expect(result.warnings.length).toBeGreaterThan(0);
	});

	it("skips a malformed finding entry but keeps the well-formed ones", () => {
		// Per-finding resilience. A reviewer that produces
		// 9 good findings and 1 garbage one shouldn't lose
		// all 9.
		const text = JSON.stringify({
			findings: [
				{
					location: { kind: "global" },
					label: "praise",
					subject: "Good",
					discussion: "Reasonable explanation.",
				},
				{
					// missing subject and discussion
					location: { kind: "global" },
					label: "issue",
				},
				{
					location: { kind: "global" },
					label: "nitpick",
					subject: "Also good",
					discussion: "Another reasonable explanation.",
				},
			],
		});
		const result = parseReviewerOutput(text, {
			reviewerId: "r1",
			runId: "run-1",
			startId: 1,
		});
		expect(result.findings).toHaveLength(2);
		expect(result.findings.map((f) => f.subject)).toEqual([
			"Good",
			"Also good",
		]);
		expect(result.warnings.length).toBe(1);
	});

	it("rejects findings whose label isn't a Conventional Comment", () => {
		// The label vocabulary is the Conventional Comments
		// set. A reviewer that emits a freeform label string
		// ("critical", "comment", "feedback") must not get
		// silently accepted; the parser drops it.
		const text = JSON.stringify({
			findings: [
				{
					location: { kind: "global" },
					label: "critical",
					subject: "x",
					discussion: "y",
				},
				{
					location: { kind: "global" },
					label: "comment",
					subject: "a",
					discussion: "b",
				},
			],
		});
		const result = parseReviewerOutput(text, {
			reviewerId: "r1",
			runId: "run-1",
			startId: 1,
		});
		expect(result.findings).toHaveLength(0);
		expect(result.warnings.length).toBe(2);
	});

	it("rejects findings with empty subject or discussion", () => {
		// Whitespace-only or empty strings aren't useful to
		// the user. The parser drops them rather than
		// promoting noise into the review draft.
		const text = JSON.stringify({
			findings: [
				{
					location: { kind: "global" },
					label: "issue",
					subject: "   ",
					discussion: "something",
				},
				{
					location: { kind: "global" },
					label: "issue",
					subject: "something",
					discussion: "",
				},
			],
		});
		const result = parseReviewerOutput(text, {
			reviewerId: "r1",
			runId: "run-1",
			startId: 1,
		});
		expect(result.findings).toHaveLength(0);
		expect(result.warnings.length).toBe(2);
	});

	it("defaults decorations to [] and state to draft", () => {
		// Optional shape fields should land at sane
		// defaults so the rest of the system can treat
		// findings uniformly.
		const text = JSON.stringify({
			findings: [
				{
					location: { kind: "global" },
					label: "thought",
					subject: "A musing",
					discussion: "Something to think about.",
				},
			],
		});
		const result = parseReviewerOutput(text, {
			reviewerId: "r1",
			runId: "run-1",
			startId: 1,
		});
		expect(result.findings[0].decorations).toEqual([]);
		expect(result.findings[0].state).toBe("draft");
	});

	it("infers category=file for line and file locations, scope for global", () => {
		// Category is derived, not asked of the reviewer.
		// Line-and-file locations map to file-category;
		// global locations map to scope-category.
		const text = JSON.stringify({
			findings: [
				{
					location: {
						kind: "line",
						file: "a.ts",
						start: 1,
						end: 1,
						side: "new",
					},
					label: "issue",
					subject: "L",
					discussion: "Line-located finding.",
				},
				{
					location: { kind: "file", file: "a.ts" },
					label: "issue",
					subject: "F",
					discussion: "File-located finding.",
				},
				{
					location: { kind: "global" },
					label: "issue",
					subject: "G",
					discussion: "Globally-located finding.",
				},
			],
		});
		const result = parseReviewerOutput(text, {
			reviewerId: "r1",
			runId: "run-1",
			startId: 1,
		});
		expect(result.findings.map((f) => f.category)).toEqual([
			"file",
			"file",
			"scope",
		]);
	});
});

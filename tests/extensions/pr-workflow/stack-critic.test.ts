import { describe, expect, it } from "vitest";
import type { FindingLocation } from "../../../extensions/pr-workflow/findings.js";
import {
	buildStackCriticPrompt,
	parseStackCriticOutput,
} from "../../../extensions/pr-workflow/stack-critic.js";

function fileLine(file: string): FindingLocation {
	return { kind: "line", file, start: 1, end: 1, side: "new" };
}

describe("buildStackCriticPrompt", () => {
	it("describes every PR in the stack with its title, body, and judge findings", () => {
		// The prompt is the entire context the stack critic
		// gets. It must include each PR's identity (number,
		// title), its body so the model can understand intent,
		// and its consolidated judge findings (the post-round-2
		// truth per PR).
		const prompt = buildStackCriticPrompt({
			cursorPrNumber: 1,
			perPr: [
				{
					prNumber: 1,
					title: "Add retry middleware",
					body: "Retries 5xx with exponential backoff.",
					judgeFindings: [
						{
							id: 1,
							location: fileLine("retry.ts"),
							label: "issue",
							decorations: [],
							subject: "Retry budget is unbounded",
							discussion: "Could DoS upstream on a long outage.",
							category: "file",
							origin: {
								kind: "judge",
								runId: "j-1",
								judgeReviewerId: "j",
							},
							state: "draft",
						},
					],
				},
				{
					prNumber: 2,
					title: "Use retry middleware in payments",
					body: "Wires the new middleware into the payments client.",
					judgeFindings: [],
				},
			],
		});

		expect(prompt).toContain("PR #1");
		expect(prompt).toContain("Add retry middleware");
		expect(prompt).toContain("Retries 5xx with exponential backoff.");
		expect(prompt).toContain("Retry budget is unbounded");
		expect(prompt).toContain("PR #2");
		expect(prompt).toContain("Use retry middleware in payments");
	});

	it("marks the cursor PR so the model knows where the user is", () => {
		// The cursor PR is where the user currently is. The
		// model defaults `homePrNumber` here when it can't
		// pick a clearer destination.
		const prompt = buildStackCriticPrompt({
			cursorPrNumber: 2,
			perPr: [
				{ prNumber: 1, title: "a", body: "x", judgeFindings: [] },
				{ prNumber: 2, title: "b", body: "y", judgeFindings: [] },
				{ prNumber: 3, title: "c", body: "z", judgeFindings: [] },
			],
		});

		expect(prompt).toMatch(/cursor.*#2|#2.*cursor/i);
	});

	it("notes when a PR in the stack has no judge findings yet", () => {
		// Stack critic shouldn't get confused by partial state.
		// PRs without reviews should be marked so the model can
		// either skip them or call out cross-PR concerns that
		// require those reviews.
		const prompt = buildStackCriticPrompt({
			cursorPrNumber: 1,
			perPr: [
				{
					prNumber: 1,
					title: "a",
					body: "x",
					judgeFindings: [
						{
							id: 1,
							location: fileLine("a.ts"),
							label: "note",
							decorations: [],
							subject: "ok",
							discussion: "fine",
							category: "file",
							origin: {
								kind: "judge",
								runId: "j",
								judgeReviewerId: "j",
							},
							state: "draft",
						},
					],
				},
				{ prNumber: 2, title: "b", body: "y", judgeFindings: [] },
			],
		});

		expect(prompt).toMatch(/PR #2[\s\S]*no judge findings|no review/i);
	});

	it("includes the StackCriticOutput JSON schema and the verify_output instruction", () => {
		// The schema goes into the prompt so the model echoes
		// the exact shape the parser expects. Verify_output is
		// the self-check loop \u2014 ensures the model checks its
		// own output before ending the run.
		const prompt = buildStackCriticPrompt({
			cursorPrNumber: 1,
			perPr: [{ prNumber: 1, title: "a", body: "x", judgeFindings: [] }],
		});
		expect(prompt).toContain("homePrNumber");
		expect(prompt).toContain("spans");
		expect(prompt).toContain("verify_output");
		expect(prompt).toContain('"stack-critic"');
	});
});

describe("parseStackCriticOutput", () => {
	it("parses a well-formed fenced JSON block and stamps ids + origin", () => {
		const json = JSON.stringify({
			findings: [
				{
					location: { kind: "global" },
					label: "issue",
					subject: "Stack-wide retry inconsistency",
					discussion: "PR #1 retries 5xx; PR #3 retries any failure.",
					homePrNumber: 1,
					spans: [1, 3],
				},
			],
		});
		const parsed = parseStackCriticOutput(
			`Here's the analysis.\n\n\`\`\`json\n${json}\n\`\`\``,
			{ runId: "sc-1", reviewerId: "stack-r1", startId: 1 },
		);

		expect(parsed.findings).toHaveLength(1);
		expect(parsed.findings[0].id).toBe(1);
		expect(parsed.findings[0].homePrNumber).toBe(1);
		expect(parsed.findings[0].spans).toEqual([1, 3]);
		expect(parsed.findings[0].origin).toEqual({
			kind: "stack-critic",
			runId: "sc-1",
			reviewerId: "stack-r1",
		});
		expect(parsed.findings[0].state).toBe("draft");
		expect(parsed.warnings).toEqual([]);
	});

	it("assigns sequential ids starting from startId", () => {
		const json = JSON.stringify({
			findings: [
				{
					location: { kind: "global" },
					label: "issue",
					subject: "a",
					discussion: "x",
					homePrNumber: 1,
					spans: [1],
				},
				{
					location: { kind: "global" },
					label: "note",
					subject: "b",
					discussion: "y",
					homePrNumber: 2,
					spans: [1, 2],
				},
			],
		});
		const parsed = parseStackCriticOutput(`\`\`\`json\n${json}\n\`\`\``, {
			runId: "sc-1",
			reviewerId: "r",
			startId: 5,
		});
		expect(parsed.findings.map((f) => f.id)).toEqual([5, 6]);
	});

	it("returns empty findings and a warning when no JSON block is present", () => {
		const parsed = parseStackCriticOutput(
			"I refuse to comply. There is no JSON here.",
			{ runId: "sc-1", reviewerId: "r", startId: 1 },
		);
		expect(parsed.findings).toEqual([]);
		expect(parsed.warnings.length).toBeGreaterThan(0);
	});

	it("skips malformed findings and warns rather than aborting", () => {
		// Resilience: one bad finding in a list shouldn't
		// throw away the good ones. A warning surfaces so the
		// user knows something was dropped.
		const json = JSON.stringify({
			findings: [
				{
					location: { kind: "global" },
					label: "issue",
					subject: "good",
					discussion: "fine",
					homePrNumber: 1,
					spans: [1, 2],
				},
				{
					// Missing homePrNumber, should be dropped.
					location: { kind: "global" },
					label: "note",
					subject: "bad",
					discussion: "missing field",
					spans: [1],
				},
			],
		});
		const parsed = parseStackCriticOutput(`\`\`\`json\n${json}\n\`\`\``, {
			runId: "sc-1",
			reviewerId: "r",
			startId: 1,
		});
		expect(parsed.findings).toHaveLength(1);
		expect(parsed.findings[0].subject).toBe("good");
		expect(parsed.warnings.length).toBeGreaterThan(0);
	});

	it("rejects unparseable JSON without throwing", () => {
		const parsed = parseStackCriticOutput("```json\nnot json\n```", {
			runId: "sc-1",
			reviewerId: "r",
			startId: 1,
		});
		expect(parsed.findings).toEqual([]);
		expect(parsed.warnings.length).toBeGreaterThan(0);
	});
});

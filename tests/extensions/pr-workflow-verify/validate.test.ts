import { describe, expect, it } from "vitest";
import { validateOutput } from "../../../extensions/pr-workflow-verify/src/validate.js";

// validate() is the pure core of the verify tool: it
// takes a stage name and arbitrary JSON-like input, runs
// schema validation, and returns either ok: true with the
// finding count or ok: false with locatable error rows.
// The tool wrapper adds nothing material on top; testing
// here covers the substance.

describe("validateOutput", () => {
	it("returns ok: true and the finding count for a valid council payload", () => {
		const result = validateOutput("council", {
			findings: [
				{
					location: { kind: "global" },
					label: "issue",
					subject: "x",
					discussion: "y",
				},
				{
					location: { kind: "global" },
					label: "note",
					subject: "a",
					discussion: "b",
				},
			],
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.count).toBe(2);
		}
	});

	it("parses stringified JSON with an actionable warning", () => {
		const result = validateOutput(
			"council",
			JSON.stringify({
				findings: [
					{
						location: { kind: "global" },
						label: "note",
						subject: "x",
						discussion: "y",
					},
				],
			}),
		);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.count).toBe(1);
			expect(result.warnings?.[0]).toContain("object itself");
		}
	});

	it("explains stringified JSON parse failures in repairable terms", () => {
		const result = validateOutput("council", '{"findings": [');

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].path).toBe("/output");
			expect(result.errors[0].message).toContain("JSON.parse failed");
			expect(result.errors[0].hint).toContain("pass the object directly");
		}
	});

	it("returns ok: false with locatable errors for an invalid payload", () => {
		// The subagent needs error rows it can act on:
		// each error carries an instancePath pointing at
		// the offending field and a human-readable message.
		const result = validateOutput("council", {
			findings: [
				{
					location: { kind: "global" },
					label: "issue",
					subject: "",
					discussion: "y",
				},
			],
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors.length).toBeGreaterThan(0);
			expect(
				result.errors.some((e) => e.path.includes("subject") && e.message),
			).toBe(true);
		}
	});

	it("rejects whitespace-only text that parent parsers would drop", () => {
		const result = validateOutput("critique", {
			critiques: [{ findingId: 1, position: "agree", rationale: "   " }],
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0]).toMatchObject({
				path: "/critiques/0/rationale",
				message: "must contain non-whitespace text",
			});
		}
	});

	it("reports the nested value type for schema failures", () => {
		const result = validateOutput("council", {
			findings: [
				{
					location: "global",
					label: "issue",
					subject: "x",
					discussion: "y",
				},
			],
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(
				result.errors.some((error) =>
					error.message.includes("received string"),
				),
			).toBe(true);
		}
	});

	it("rejects an unknown stage name with a clear error", () => {
		// Defensive: if the subagent passes a typo'd stage,
		// we want a single error explaining the allowed
		// values, not a crash.
		const result = validateOutput("counsel" as never, { findings: [] });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors.length).toBe(1);
			expect(result.errors[0].message).toContain("unknown stage");
		}
	});

	it("rejects the removed stack-critic stage", () => {
		const result = validateOutput("stack-critic" as never, { findings: [] });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].message).toContain("unknown stage");
		}
	});

	it("validates a judge payload using the judge schema", () => {
		const result = validateOutput("judge", {
			findings: [
				{
					location: { kind: "global" },
					label: "issue",
					subject: "x",
					discussion: "y",
					raisedBy: ["a"],
					sourceFindingIds: [1],
				},
			],
		});
		expect(result.ok).toBe(true);
	});

	it("validates a critique payload using the critique schema", () => {
		const result = validateOutput("critique", {
			critiques: [{ findingId: 1, position: "agree", rationale: "ok" }],
		});
		expect(result.ok).toBe(true);
	});

	it("validates a stack-review payload and counts per-PR plus cross-PR findings", () => {
		const result = validateOutput("stack-review", {
			perPr: {
				"101": [
					{
						location: { kind: "global" },
						label: "issue",
						subject: "PR-specific issue",
						discussion: "This belongs to PR #101.",
					},
				],
				"102": [
					{
						location: { kind: "file", file: "task.go" },
						label: "suggestion",
						subject: "Another PR-specific issue",
						discussion: "This belongs to PR #102.",
					},
				],
			},
			crossPr: [
				{
					location: { kind: "global" },
					label: "issue",
					subject: "Cross-PR ordering issue",
					discussion: "PR #102 assumes a helper from PR #101 before it exists.",
					homePrNumber: 101,
					spans: [101, 102],
				},
			],
		});
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.count).toBe(3);
	});

	it("rejects stack-review maps keyed by non-PR numbers", () => {
		const result = validateOutput("stack-review", {
			perPr: {
				main: [],
			},
			crossPr: [],
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors.some((e) => e.path.includes("main"))).toBe(true);
		}
	});

	it("validates a stack-judge payload and counts per-PR plus cross-PR findings", () => {
		const result = validateOutput("stack-judge", {
			selfSignal: { confidence: "high", rationale: "Clean agreement." },
			perPr: {
				"101": [
					{
						location: { kind: "global" },
						label: "issue",
						subject: "Consolidated per-PR issue",
						discussion: "Judge synthesis for PR #101.",
						raisedBy: ["fast"],
						sourceFindingIds: [1],
					},
				],
			},
			crossPr: [
				{
					location: { kind: "global" },
					label: "issue",
					subject: "Consolidated cross-PR issue",
					discussion: "Judge synthesis across PRs.",
					homePrNumber: 101,
					spans: [101, 102],
					raisedBy: ["fast", "skeptic"],
					sourceFindingIds: [3, 4],
				},
			],
		});
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.count).toBe(2);
	});
});

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
});

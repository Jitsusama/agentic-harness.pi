import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
	CouncilFindingsOutput,
	CritiqueOutput,
	getSchema,
	JudgeOutput,
} from "../../../extensions/pr-workflow/schemas.js";

// The schema is the single source of truth for the
// subagent → parent contract. These tests pin three things:
// (1) realistic well-formed shapes validate; (2) common
// malformations are rejected with locatable errors; (3) the
// stage-keyed selector resolves to the right schema.
//
// Coverage is intentionally exhaustive on the council
// schema (the most-used) and lighter on the other two; the
// shapes share a finding subtype, so testing it once is
// enough.

describe("CouncilFindingsOutput", () => {
	it("accepts a minimal valid output (empty findings)", () => {
		// The "found nothing" reply is a real and important
		// case; we don't want the schema to force the reviewer
		// to invent issues.
		expect(Value.Check(CouncilFindingsOutput, { findings: [] })).toBe(true);
	});

	it("accepts a populated output with all optional fields", () => {
		const output = {
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
					subject: "Race condition between writes",
					discussion: "Two writers can interleave; needs a mutex.",
					severity: "critical",
					confidence: 0.9,
				},
			],
		};
		expect(Value.Check(CouncilFindingsOutput, output)).toBe(true);
	});

	it("accepts file and global location kinds", () => {
		const fileLocation = {
			findings: [
				{
					location: { kind: "file", file: "src/foo.ts" },
					label: "note",
					subject: "Long module worth splitting",
					discussion: "Two distinct concerns are interleaved here.",
				},
			],
		};
		const globalLocation = {
			findings: [
				{
					location: { kind: "global" },
					label: "thought",
					subject: "PR description could explain rollout plan",
					discussion: "Reviewers can't tell when this ships.",
				},
			],
		};
		expect(Value.Check(CouncilFindingsOutput, fileLocation)).toBe(true);
		expect(Value.Check(CouncilFindingsOutput, globalLocation)).toBe(true);
	});

	it("rejects a top-level shape missing findings", () => {
		// Common malformation: the model writes `{notes: [...]}`
		// or returns a bare array.
		expect(Value.Check(CouncilFindingsOutput, {})).toBe(false);
		expect(Value.Check(CouncilFindingsOutput, [])).toBe(false);
		expect(Value.Check(CouncilFindingsOutput, { notes: [] })).toBe(false);
	});

	it("rejects an unknown label", () => {
		// Conventional Comments labels are bounded; the schema
		// catches typos like "issues" or "suggestions" instead
		// of failing silently downstream.
		const output = {
			findings: [
				{
					location: { kind: "global" },
					label: "issues",
					subject: "x",
					discussion: "y",
				},
			],
		};
		expect(Value.Check(CouncilFindingsOutput, output)).toBe(false);
	});

	it("rejects an empty subject or discussion", () => {
		// Empty strings produce useless review comments. We
		// require minimum length 1 so the model has to put
		// something there.
		const output = {
			findings: [
				{
					location: { kind: "global" },
					label: "issue",
					subject: "",
					discussion: "y",
				},
			],
		};
		expect(Value.Check(CouncilFindingsOutput, output)).toBe(false);
	});

	it("rejects a confidence outside 0..1", () => {
		const output = {
			findings: [
				{
					location: { kind: "global" },
					label: "issue",
					subject: "x",
					discussion: "y",
					confidence: 1.5,
				},
			],
		};
		expect(Value.Check(CouncilFindingsOutput, output)).toBe(false);
	});

	it("rejects a malformed line location", () => {
		const output = {
			findings: [
				{
					location: { kind: "line", file: "a.ts", start: 5 },
					label: "issue",
					subject: "x",
					discussion: "y",
				},
			],
		};
		expect(Value.Check(CouncilFindingsOutput, output)).toBe(false);
	});

	it("produces locatable errors for the subagent to act on", () => {
		// Self-verify needs concrete error paths, not just "no".
		// `Value.Errors` yields each problem with a JSON
		// pointer path; we exercise that here so prompt
		// instructions can mention specific paths.
		const output = {
			findings: [
				{
					location: { kind: "global" },
					label: "issue",
					subject: "",
					discussion: "y",
				},
			],
		};
		const errors = [...Value.Errors(CouncilFindingsOutput, output)];
		expect(errors.length).toBeGreaterThan(0);
		expect(errors.some((e) => e.instancePath.includes("subject"))).toBe(true);
	});
});

describe("JudgeOutput", () => {
	it("accepts a populated output with self-signal and agreement fields", () => {
		const output = {
			selfSignal: { confidence: "high", rationale: "All raised by 3+" },
			findings: [
				{
					location: { kind: "global" },
					label: "issue",
					subject: "x",
					discussion: "y",
					raisedBy: ["a", "b"],
					sourceFindingIds: [1, 5],
				},
			],
		};
		expect(Value.Check(JudgeOutput, output)).toBe(true);
	});

	it("accepts an output without selfSignal", () => {
		// selfSignal is optional; not every judge supplies it.
		expect(Value.Check(JudgeOutput, { findings: [] })).toBe(true);
	});

	it("rejects raisedBy that is not an array of strings", () => {
		const output = {
			findings: [
				{
					location: { kind: "global" },
					label: "issue",
					subject: "x",
					discussion: "y",
					raisedBy: "a",
					sourceFindingIds: [1],
				},
			],
		};
		expect(Value.Check(JudgeOutput, output)).toBe(false);
	});
});

describe("CritiqueOutput", () => {
	it("accepts a populated critique output", () => {
		const output = {
			critiques: [
				{ findingId: 1, position: "agree", rationale: "Confirmed." },
				{ findingId: 2, position: "disagree", rationale: "Looks fine to me." },
			],
		};
		expect(Value.Check(CritiqueOutput, output)).toBe(true);
	});

	it("rejects an unknown position", () => {
		const output = {
			critiques: [{ findingId: 1, position: "veto", rationale: "no" }],
		};
		expect(Value.Check(CritiqueOutput, output)).toBe(false);
	});

	it("rejects a non-integer findingId", () => {
		// findingId references a parent-assigned id; non-ints
		// are nonsense and cause lookup failures downstream.
		const output = {
			critiques: [{ findingId: 1.5, position: "agree", rationale: "x" }],
		};
		expect(Value.Check(CritiqueOutput, output)).toBe(false);
	});
});

describe("getSchema", () => {
	it("returns the matching schema for each stage name", () => {
		expect(getSchema("council")).toBe(CouncilFindingsOutput);
		expect(getSchema("judge")).toBe(JudgeOutput);
		expect(getSchema("critique")).toBe(CritiqueOutput);
	});
});

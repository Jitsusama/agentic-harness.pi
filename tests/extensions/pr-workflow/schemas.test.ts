import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
	ConventionalLabel,
	CouncilFindingsOutput,
	CritiqueOutput,
	CritiquePosition,
	FindingLocation,
	FindingSeverity,
	FindingSide,
	getSchema,
	JudgeOutput,
	JudgeSelfSignal,
	StackCrossFinding,
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

	it("accepts a finding without raisedBy or sourceFindingIds", () => {
		// A judge insight can legitimately have no
		// upstream reviewer (the judge surfaced it on its
		// own). Agreement metadata is optional; absence is
		// fine, what we reject is presence with the wrong
		// type.
		const output = {
			findings: [
				{
					location: { kind: "global" },
					label: "issue",
					subject: "Lone insight",
					discussion: "d",
				},
			],
		};
		expect(Value.Check(JudgeOutput, output)).toBe(true);
	});

	it("rejects raisedBy that is present but not an array of strings", () => {
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

describe("StackCrossFinding", () => {
	it("accepts a populated cross-PR finding", () => {
		const finding = {
			location: { kind: "global" },
			label: "issue",
			subject: "Inconsistent error handling across the stack",
			discussion: "PR #1 throws on validation failure; PR #3 returns a Result.",
			homePrNumber: 1,
			spans: [1, 3],
		};
		expect(Value.Check(StackCrossFinding, finding)).toBe(true);
	});

	it("accepts a single-PR-spanned finding", () => {
		const finding = {
			location: { kind: "global" },
			label: "note",
			subject: "This API choice only makes sense if PR #2 lands",
			discussion: "Standalone it looks arbitrary.",
			homePrNumber: 1,
			spans: [1],
		};
		expect(Value.Check(StackCrossFinding, finding)).toBe(true);
	});

	it("rejects a finding with no spans", () => {
		const finding = {
			location: { kind: "global" },
			label: "issue",
			subject: "x",
			discussion: "y",
			homePrNumber: 1,
			spans: [],
		};
		expect(Value.Check(StackCrossFinding, finding)).toBe(false);
	});

	it("rejects a finding missing homePrNumber", () => {
		const finding = {
			location: { kind: "global" },
			label: "issue",
			subject: "x",
			discussion: "y",
			spans: [1, 2],
		};
		expect(Value.Check(StackCrossFinding, finding)).toBe(false);
	});
});

describe("getSchema", () => {
	it("returns the matching schema for each stage name", () => {
		expect(getSchema("council")).toBe(CouncilFindingsOutput);
		expect(getSchema("judge")).toBe(JudgeOutput);
		expect(getSchema("critique")).toBe(CritiqueOutput);
	});
});

describe("vocabulary schemas", () => {
	// These small schemas are exported on their own so
	// other code can reference them (or their derived
	// types) without re-hard-coding the literals. The
	// label, severity, position, side and location
	// vocabularies live in one place; if a value moves
	// in or out, only schemas.ts and these tests change.

	it("ConventionalLabel accepts every Conventional Comment", () => {
		for (const label of [
			"praise",
			"nitpick",
			"suggestion",
			"issue",
			"todo",
			"question",
			"thought",
			"chore",
			"note",
			"typo",
			"polish",
			"quibble",
		]) {
			expect(Value.Check(ConventionalLabel, label)).toBe(true);
		}
	});

	it("ConventionalLabel rejects freeform strings", () => {
		expect(Value.Check(ConventionalLabel, "critical")).toBe(false);
		expect(Value.Check(ConventionalLabel, "comment")).toBe(false);
	});

	it("FindingSeverity has exactly three buckets", () => {
		expect(Value.Check(FindingSeverity, "critical")).toBe(true);
		expect(Value.Check(FindingSeverity, "medium")).toBe(true);
		expect(Value.Check(FindingSeverity, "minor")).toBe(true);
		expect(Value.Check(FindingSeverity, "high")).toBe(false);
	});

	it("FindingSide accepts old, new, both", () => {
		for (const side of ["old", "new", "both"]) {
			expect(Value.Check(FindingSide, side)).toBe(true);
		}
		expect(Value.Check(FindingSide, "left")).toBe(false);
	});

	it("CritiquePosition has the four allowed positions", () => {
		for (const pos of ["agree", "disagree", "qualify", "amplify"]) {
			expect(Value.Check(CritiquePosition, pos)).toBe(true);
		}
		expect(Value.Check(CritiquePosition, "veto")).toBe(false);
	});

	it("FindingLocation accepts each kind with the right shape", () => {
		expect(
			Value.Check(FindingLocation, {
				kind: "line",
				file: "a.ts",
				start: 1,
				end: 2,
				side: "new",
			}),
		).toBe(true);
		expect(Value.Check(FindingLocation, { kind: "file", file: "a.ts" })).toBe(
			true,
		);
		expect(Value.Check(FindingLocation, { kind: "global" })).toBe(true);
	});

	it("FindingLocation rejects an empty file path", () => {
		// `file` is a required, non-empty string on both
		// the line and file variants. An empty path is a
		// hallucination, not a valid location.
		expect(Value.Check(FindingLocation, { kind: "file", file: "" })).toBe(
			false,
		);
	});

	it("FindingLocation rejects line locations with start < 1", () => {
		// Line numbers are 1-indexed. 0 (and negatives) are
		// nonsense and break downstream GitHub posting.
		expect(
			Value.Check(FindingLocation, {
				kind: "line",
				file: "a.ts",
				start: 0,
				end: 1,
				side: "new",
			}),
		).toBe(false);
	});

	it("JudgeSelfSignal requires confidence in the enum and non-empty rationale", () => {
		expect(
			Value.Check(JudgeSelfSignal, { confidence: "high", rationale: "ok" }),
		).toBe(true);
		expect(
			Value.Check(JudgeSelfSignal, { confidence: "wat", rationale: "ok" }),
		).toBe(false);
		expect(
			Value.Check(JudgeSelfSignal, { confidence: "high", rationale: "" }),
		).toBe(false);
	});
});

describe("tightened constraints", () => {
	// Tighter rules introduced when schemas became the
	// authoritative source of truth.

	it("rejects findings with empty raisedBy strings on the judge schema", () => {
		// raisedBy items reference reviewer ids; empty
		// strings are nonsense and would corrupt the
		// agreement table downstream.
		const output = {
			findings: [
				{
					location: { kind: "global" },
					label: "issue",
					subject: "x",
					discussion: "y",
					raisedBy: [""],
					sourceFindingIds: [1],
				},
			],
		};
		expect(Value.Check(JudgeOutput, output)).toBe(false);
	});

	it("rejects findings with empty decoration strings on round 1", () => {
		const output = {
			findings: [
				{
					location: { kind: "global" },
					label: "issue",
					subject: "x",
					discussion: "y",
					decorations: [""],
				},
			],
		};
		expect(Value.Check(CouncilFindingsOutput, output)).toBe(false);
	});
});

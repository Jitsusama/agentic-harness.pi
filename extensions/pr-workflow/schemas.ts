/**
 * Reviewer output schemas.
 *
 * The single source of truth for what each reviewer
 * subagent must emit, and for the corresponding
 * TypeScript types the rest of the codebase consumes.
 * One declaration per concept; everything else
 * (findings.ts, critique.ts, parsers, prompts, the
 * verify extension) imports from here.
 *
 * For each concept we export a pair:
 *
 *   - The TypeBox schema (PascalCase, e.g. `Label`).
 *     Used by `verify_output`, the parent parsers, and
 *     stringified into prompts as JSON Schema.
 *   - A TypeScript type of the same name, derived via
 *     `Static<typeof Schema>`. Imported wherever code
 *     reads or constructs a value of that shape.
 *
 * TypeScript keeps value-namespace and type-namespace
 * bindings separate, so `Label` works as both
 * `import { Label }` (the schema) and
 * `import type { Label }` (the type).
 *
 * Stages:
 *
 *   - `CouncilFindingsOutput` — round 1 reviewer output.
 *   - `JudgeOutput` — round 2 consolidated output
 *     (judge's optional self-signal plus per-finding
 *     agreement metadata).
 *   - `CritiqueOutput` — round 3 push-back from the
 *     reviewers on the judge's consolidation.
 *   - `StackReviewOutput` — stack-wide reviewer output,
 *     split into per-PR findings and cross-PR findings.
 *   - `StackJudgeOutput` — stack-wide judge output, split
 *     the same way after consolidation.
 *
 * Keep this file authoritative. If a subagent's allowed
 * output shape changes, change it here first and
 * everything else follows.
 */

import { type Static, Type } from "@sinclair/typebox";

// ---------------------------------------------------------------------------
// Vocabularies
//
// These are the small enums and unions every higher-level
// schema composes from. Each is exported as both a
// runtime schema and a static type.
// ---------------------------------------------------------------------------

/** Conventional Comments labels accepted on findings. */
export const ConventionalLabel = Type.Union([
	Type.Literal("praise"),
	Type.Literal("nitpick"),
	Type.Literal("suggestion"),
	Type.Literal("issue"),
	Type.Literal("todo"),
	Type.Literal("question"),
	Type.Literal("thought"),
	Type.Literal("chore"),
	Type.Literal("note"),
	Type.Literal("typo"),
	Type.Literal("polish"),
	Type.Literal("quibble"),
]);
export type ConventionalLabel = Static<typeof ConventionalLabel>;

/** Severity buckets for findings. Optional on the wire. */
export const FindingSeverity = Type.Union([
	Type.Literal("critical"),
	Type.Literal("medium"),
	Type.Literal("minor"),
]);
export type FindingSeverity = Static<typeof FindingSeverity>;

/** Which side of the diff a line-located finding points at. */
export const FindingSide = Type.Union([
	Type.Literal("old"),
	Type.Literal("new"),
	Type.Literal("both"),
]);
export type FindingSide = Static<typeof FindingSide>;

/** Where a finding points to. A three-variant discriminated union. */
export const FindingLocation = Type.Union([
	Type.Object({
		kind: Type.Literal("line"),
		file: Type.String({ minLength: 1 }),
		start: Type.Integer({ minimum: 1 }),
		end: Type.Integer({ minimum: 1 }),
		side: FindingSide,
	}),
	Type.Object({
		kind: Type.Literal("file"),
		file: Type.String({ minLength: 1 }),
	}),
	Type.Object({
		kind: Type.Literal("global"),
	}),
]);
export type FindingLocation = Static<typeof FindingLocation>;

/** Reviewer's stance on a single consolidated finding. */
export const CritiquePosition = Type.Union([
	Type.Literal("agree"),
	Type.Literal("disagree"),
	Type.Literal("qualify"),
	Type.Literal("amplify"),
]);
export type CritiquePosition = Static<typeof CritiquePosition>;

/** Judge's self-confidence signal on its consolidation. */
export const JudgeSelfSignal = Type.Object({
	confidence: Type.Union([
		Type.Literal("low"),
		Type.Literal("medium"),
		Type.Literal("high"),
	]),
	rationale: Type.String({ minLength: 1 }),
});
export type JudgeSelfSignal = Static<typeof JudgeSelfSignal>;

// ---------------------------------------------------------------------------
// Round 1 — council
// ---------------------------------------------------------------------------

/** A round-1 reviewer finding. */
export const CouncilFinding = Type.Object({
	location: FindingLocation,
	label: ConventionalLabel,
	decorations: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
	subject: Type.String({ minLength: 1 }),
	discussion: Type.String({ minLength: 1 }),
	severity: Type.Optional(FindingSeverity),
	confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
});
export type CouncilFinding = Static<typeof CouncilFinding>;

/** Round-1 reviewer output. */
export const CouncilFindingsOutput = Type.Object({
	findings: Type.Array(CouncilFinding),
});
export type CouncilFindingsOutput = Static<typeof CouncilFindingsOutput>;

// ---------------------------------------------------------------------------
// Round 2 — judge
//
// Same core finding shape as round 1, with two extra
// agreement-metadata fields (`raisedBy`,
// `sourceFindingIds`). These are optional because a
// judge insight can legitimately have no upstream
// reviewer (the judge surfaced it on its own); when
// present they MUST be the right type, so a judge that
// emits `raisedBy: "fast"` instead of `["fast"]` fails
// schema validation. The top-level `selfSignal` carries
// the judge's confidence in its own consolidation.
// ---------------------------------------------------------------------------

/** A round-2 consolidated finding. */
export const JudgeFinding = Type.Object({
	location: FindingLocation,
	label: ConventionalLabel,
	decorations: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
	subject: Type.String({ minLength: 1 }),
	discussion: Type.String({ minLength: 1 }),
	severity: Type.Optional(FindingSeverity),
	confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
	raisedBy: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
	sourceFindingIds: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }))),
});
export type JudgeFinding = Static<typeof JudgeFinding>;

/** Round-2 judge output. */
export const JudgeOutput = Type.Object({
	selfSignal: Type.Optional(JudgeSelfSignal),
	findings: Type.Array(JudgeFinding),
});
export type JudgeOutput = Static<typeof JudgeOutput>;

// ---------------------------------------------------------------------------
// Round 3 — critique
// ---------------------------------------------------------------------------

/**
 * Critique entry: one reviewer's position on one of the
 * judge's consolidated findings.
 */
export const CritiqueEntry = Type.Object({
	findingId: Type.Integer({ minimum: 1 }),
	position: CritiquePosition,
	rationale: Type.String({ minLength: 1 }),
});
export type CritiqueEntry = Static<typeof CritiqueEntry>;

/** Round-3 critique output. */
export const CritiqueOutput = Type.Object({
	critiques: Type.Array(CritiqueEntry),
});
export type CritiqueOutput = Static<typeof CritiqueOutput>;

// ---------------------------------------------------------------------------
// Cross-PR review findings
//
// Cross-PR findings have the same core shape as judge
// findings (location, label, subject, discussion,
// severity, confidence) but no agreement metadata before
// judge consolidation. Two extra fields are required:
// `homePrNumber` picks the post destination, and `spans`
// lists every PR the finding refers to (always non-empty).
// ---------------------------------------------------------------------------

/** A cross-PR reviewer finding. */
export const StackCrossFinding = Type.Object({
	location: FindingLocation,
	label: ConventionalLabel,
	decorations: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
	subject: Type.String({ minLength: 1 }),
	discussion: Type.String({ minLength: 1 }),
	severity: Type.Optional(FindingSeverity),
	confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
	homePrNumber: Type.Integer({ minimum: 1 }),
	spans: Type.Array(Type.Integer({ minimum: 1 }), { minItems: 1 }),
});
export type StackCrossFinding = Static<typeof StackCrossFinding>;

// ---------------------------------------------------------------------------
// Stack-wide review
// ---------------------------------------------------------------------------

/** Object keys for PR-number-indexed finding maps. */
export const PrNumberKey = Type.String({ pattern: "^[1-9][0-9]*$" });
export type PrNumberKey = Static<typeof PrNumberKey>;

/** Per-PR findings keyed by PR number. */
export const PerPrCouncilFindings = Type.Record(
	PrNumberKey,
	Type.Array(CouncilFinding),
);
export type PerPrCouncilFindings = Static<typeof PerPrCouncilFindings>;

/** Stack-wide reviewer output. */
export const StackReviewOutput = Type.Object({
	perPr: PerPrCouncilFindings,
	crossPr: Type.Array(StackCrossFinding),
});
export type StackReviewOutput = Static<typeof StackReviewOutput>;

/** Cross-PR consolidated finding from the stack judge. */
export const StackJudgeCrossFinding = Type.Object({
	location: FindingLocation,
	label: ConventionalLabel,
	decorations: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
	subject: Type.String({ minLength: 1 }),
	discussion: Type.String({ minLength: 1 }),
	severity: Type.Optional(FindingSeverity),
	confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
	homePrNumber: Type.Integer({ minimum: 1 }),
	spans: Type.Array(Type.Integer({ minimum: 1 }), { minItems: 1 }),
	raisedBy: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
	sourceFindingIds: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }))),
});
export type StackJudgeCrossFinding = Static<typeof StackJudgeCrossFinding>;

/** Per-PR judge findings keyed by PR number. */
export const PerPrJudgeFindings = Type.Record(
	PrNumberKey,
	Type.Array(JudgeFinding),
);
export type PerPrJudgeFindings = Static<typeof PerPrJudgeFindings>;

/** Stack-wide judge output. */
export const StackJudgeOutput = Type.Object({
	selfSignal: Type.Optional(JudgeSelfSignal),
	perPr: PerPrJudgeFindings,
	crossPr: Type.Array(StackJudgeCrossFinding),
});
export type StackJudgeOutput = Static<typeof StackJudgeOutput>;

// ---------------------------------------------------------------------------
// Stage registry
// ---------------------------------------------------------------------------

/** Stage names that key into the schema registry. */
export type StageName =
	| "council"
	| "judge"
	| "critique"
	| "stack-review"
	| "stack-judge";

/**
 * Resolve a stage name to its schema. Used by the verify
 * extension's tool body and anywhere prompts assemble
 * schema text dynamically.
 */
export function getSchema(stage: StageName) {
	switch (stage) {
		case "council":
			return CouncilFindingsOutput;
		case "judge":
			return JudgeOutput;
		case "critique":
			return CritiqueOutput;
		case "stack-review":
			return StackReviewOutput;
		case "stack-judge":
			return StackJudgeOutput;
	}
}

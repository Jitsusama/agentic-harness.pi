/**
 * Reviewer output schemas.
 *
 * The single source of truth for what each reviewer
 * subagent must emit. Three stages, three schemas:
 *
 *   - `CouncilFindingsOutput` — round 1 reviewer output.
 *   - `JudgeOutput` — round 2 consolidated output (carries
 *     the judge's optional self-signal and per-finding
 *     agreement metadata).
 *   - `CritiqueOutput` — round 3 push-back from reviewers
 *     on the judge's consolidation.
 *
 * These schemas serve four roles:
 *
 *   1. Runtime contract used by the parent parser
 *      (`parse.ts`, `judge.ts`, `critique.ts`) so any
 *      reviewer JSON that passes here can be trusted.
 *   2. Runtime contract used by the subagent's
 *      `verify_output` tool (the pr-workflow-verify
 *      sibling extension), so the subagent can
 *      self-check before ending its run.
 *   3. JSON-Schema snippet embedded in the reviewer
 *      prompt so the model knows the exact contract it
 *      will be validated against.
 *   4. Source of TypeScript types via TypeBox's
 *      `Static<>` helper.
 *
 * Keep this file authoritative. If a subagent's allowed
 * output shape changes, change it here first and
 * everything else follows.
 */

import { type Static, Type } from "@sinclair/typebox";

/** Conventional Comments labels accepted on findings. */
const Label = Type.Union([
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

/** Severity buckets for findings (optional on output). */
const Severity = Type.Union([
	Type.Literal("critical"),
	Type.Literal("medium"),
	Type.Literal("minor"),
]);

/** Where a finding points to. Three discriminated variants. */
const FindingLocation = Type.Union([
	Type.Object({
		kind: Type.Literal("line"),
		file: Type.String({ minLength: 1 }),
		start: Type.Integer({ minimum: 1 }),
		end: Type.Integer({ minimum: 1 }),
		side: Type.Union([
			Type.Literal("old"),
			Type.Literal("new"),
			Type.Literal("both"),
		]),
	}),
	Type.Object({
		kind: Type.Literal("file"),
		file: Type.String({ minLength: 1 }),
	}),
	Type.Object({
		kind: Type.Literal("global"),
	}),
]);

/** A round-1 reviewer finding. */
export const CouncilFinding = Type.Object({
	location: FindingLocation,
	label: Label,
	decorations: Type.Optional(Type.Array(Type.String())),
	subject: Type.String({ minLength: 1 }),
	discussion: Type.String({ minLength: 1 }),
	severity: Type.Optional(Severity),
	confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
});

/** Round-1 reviewer output. */
export const CouncilFindingsOutput = Type.Object({
	findings: Type.Array(CouncilFinding),
});

/** Inferred type for council reviewer output. */
export type CouncilFindingsOutputT = Static<typeof CouncilFindingsOutput>;

/**
 * Judge consolidation output.
 *
 * Same core finding shape as round 1, with two extra
 * agreement-metadata fields (`raisedBy`,
 * `sourceFindingIds`). These are optional because a
 * judge insight can legitimately have no upstream
 * reviewer (the judge surfaced it on its own); when
 * present they MUST be the right type, so a judge that
 * emits `raisedBy: "fast"` instead of `["fast"]` fails
 * schema validation. The top-level `selfSignal`
 * captures the judge's confidence in its own
 * consolidation.
 */
/** Judge's self-confidence signal on its consolidation. */
export const JudgeSelfSignalSchema = Type.Object({
	confidence: Type.Union([
		Type.Literal("low"),
		Type.Literal("medium"),
		Type.Literal("high"),
	]),
	rationale: Type.String({ minLength: 1 }),
});

export const JudgeFinding = Type.Object({
	location: FindingLocation,
	label: Label,
	decorations: Type.Optional(Type.Array(Type.String())),
	subject: Type.String({ minLength: 1 }),
	discussion: Type.String({ minLength: 1 }),
	severity: Type.Optional(Severity),
	confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
	raisedBy: Type.Optional(Type.Array(Type.String())),
	sourceFindingIds: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }))),
});

export const JudgeOutput = Type.Object({
	selfSignal: Type.Optional(JudgeSelfSignalSchema),
	findings: Type.Array(JudgeFinding),
});

/** Inferred type for judge output. */
export type JudgeOutputT = Static<typeof JudgeOutput>;

/**
 * Critique entry: a single reviewer's position on one of
 * the judge's consolidated findings.
 */
export const CritiqueEntry = Type.Object({
	findingId: Type.Integer({ minimum: 1 }),
	position: Type.Union([
		Type.Literal("agree"),
		Type.Literal("disagree"),
		Type.Literal("qualify"),
		Type.Literal("amplify"),
	]),
	rationale: Type.String({ minLength: 1 }),
});

export const CritiqueOutput = Type.Object({
	critiques: Type.Array(CritiqueEntry),
});

/** Inferred type for critique output. */
export type CritiqueOutputT = Static<typeof CritiqueOutput>;

/** Stage names that key into the schema registry. */
export type StageName = "council" | "judge" | "critique";

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
	}
}

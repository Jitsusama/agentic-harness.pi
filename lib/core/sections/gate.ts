/**
 * The section gate: a thin adapter over the shared loop breaker
 * in the gate module. It supplies the section-specific detection,
 * block formatting and relent wording; the block-first,
 * relent-on-repeat mechanism lives in decideGate so prose and
 * sections share one behaviour.
 */

import { decideGate, type GateDecision } from "../gate/index.ts";
import { formatSectionBlock } from "./block.ts";
import { detectSectionViolations, type SectionViolation } from "./detect.ts";
import {
	type BodyShape,
	detectShapeViolations,
	type ShapeViolation,
} from "./shape.ts";
import { formatShapeBlock } from "./shape-block.ts";

/** What the gate needs to know about the artifact under review. */
export interface SectionGateConfig {
	/** The closed set of sanctioned headings for this artifact. */
	readonly sanctioned: readonly string[];
	/** "PR" or "issue", for the block message. */
	readonly entityLabel: string;
	/** The format skill that owns the section set, for the message. */
	readonly skill: string;
	/**
	 * What each section may hold, when the artifact has rules beyond its
	 * headings. The PR has; the issue, so far, has not.
	 */
	readonly shape?: BodyShape;
}

/** A heading problem or a shape problem, as one set the gate can sign. */
export type BodyViolation = SectionViolation | ShapeViolation;

/** Every way a body breaks its sections and, where it has one, its shape. */
export function detectBodyViolations(
	body: string,
	config: Pick<SectionGateConfig, "sanctioned" | "shape">,
): BodyViolation[] {
	return [
		...detectSectionViolations(body, config.sanctioned),
		...(config.shape ? detectShapeViolations(body, config.shape) : []),
	];
}

/**
 * One message for every heading and shape problem, headings first:
 * there is no point trimming the words in a section that should not
 * exist. Empty when the body is clean.
 */
export function formatBodyBlock(
	violations: BodyViolation[],
	entityLabel: string,
	skill: string,
): string {
	const sections = violations.filter(
		(v): v is SectionViolation => v.kind === "section",
	);
	const shapes = violations.filter(
		(v): v is ShapeViolation => v.kind === "shape",
	);
	return [
		formatSectionBlock(sections, entityLabel, skill),
		formatShapeBlock(shapes, entityLabel, skill),
	]
		.filter((block) => block !== "")
		.join("\n\n");
}

/** The gate's verdict on one body's sections. */
export type SectionGateDecision = GateDecision;

/** Decide whether to block, relent or allow given prior block signatures. */
export function sectionGateDecision(
	body: string,
	priorSignatures: string[],
	config: SectionGateConfig,
): SectionGateDecision {
	const violations = detectBodyViolations(body, config);
	const relentPrefix = [
		`This ${config.entityLabel} body still breaks the ${config.skill}`,
		"sections or their shape after a previous attempt, so it is being",
		"let through rather than blocked again. Review the remaining problems",
		"yourself:",
		"",
	].join("\n");
	return decideGate(
		violations,
		priorSignatures,
		(v) => formatBodyBlock(v, config.entityLabel, config.skill),
		relentPrefix,
		body,
	);
}

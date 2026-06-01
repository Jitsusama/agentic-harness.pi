/**
 * The section gate: a thin adapter over the shared loop breaker
 * in lib/gate. It supplies the section-specific detection, block
 * formatting and relent wording; the block-first,
 * relent-on-repeat mechanism lives in decideGate so prose and
 * sections share one behaviour.
 */

import { decideGate, type GateDecision } from "../gate/index.js";
import { formatSectionBlock } from "./block.js";
import { detectSectionViolations } from "./detect.js";

/** What the gate needs to know about the artifact under review. */
export interface SectionGateConfig {
	/** The closed set of sanctioned headings for this artifact. */
	readonly sanctioned: readonly string[];
	/** "PR" or "issue", for the block message. */
	readonly entityLabel: string;
	/** The format skill that owns the section set, for the message. */
	readonly skill: string;
}

/** The gate's verdict on one body's sections. */
export type SectionGateDecision = GateDecision;

/** Decide whether to block, relent or allow given prior block signatures. */
export function sectionGateDecision(
	body: string,
	priorSignatures: string[],
	config: SectionGateConfig,
): SectionGateDecision {
	const violations = detectSectionViolations(body, config.sanctioned);
	const relentPrefix = [
		`This ${config.entityLabel} body still breaks the ${config.skill}`,
		"section set after a previous attempt, so it is being let through",
		"rather than blocked again. Review the remaining section problems",
		"yourself:",
		"",
	].join("\n");
	return decideGate(
		violations,
		priorSignatures,
		(v) => formatSectionBlock(v, config.entityLabel, config.skill),
		relentPrefix,
		body,
	);
}

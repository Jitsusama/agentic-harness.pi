/**
 * The title gate: a thin adapter over the shared loop breaker in
 * lib/gate. It supplies the title-specific detection, block
 * formatting and relent wording; the block-first,
 * relent-on-repeat mechanism lives in decideGate so titles share
 * one behaviour with prose, sections and Slack.
 */

import { decideGate, type GateDecision } from "../gate/index.js";
import { formatTitleBlock } from "./block.js";
import { detectTitleViolations } from "./detect.js";

/** What the gate needs to know about the artifact under review. */
export interface TitleGateConfig {
	/** "PR" or "issue", for the block message. */
	readonly entityLabel: string;
	/** The format skill that owns the title rules, for the message. */
	readonly skill: string;
}

/** The gate's verdict on one title. */
export type TitleGateDecision = GateDecision;

/** Decide whether to block, relent or allow given prior block signatures. */
export function titleGateDecision(
	title: string,
	priorSignatures: string[],
	config: TitleGateConfig,
): TitleGateDecision {
	const violations = detectTitleViolations(title);
	const relentPrefix = [
		`This ${config.entityLabel} title still breaks the ${config.skill}`,
		"title convention after a previous attempt, so it is being let",
		"through rather than blocked again. Review it yourself:",
		"",
	].join("\n");
	return decideGate(
		violations,
		priorSignatures,
		(v) => formatTitleBlock(v, config.entityLabel, config.skill),
		relentPrefix,
		title,
	);
}

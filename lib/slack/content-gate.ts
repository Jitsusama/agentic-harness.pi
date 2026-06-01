/**
 * The Slack content gate: a thin adapter over the shared loop
 * breaker in lib/gate. It supplies the Slack-specific detection,
 * block formatting and relent wording; the block-first,
 * relent-on-repeat mechanism lives in decideGate so prose,
 * sections and Slack share one behaviour.
 */

import { decideGate, type GateDecision } from "../gate/index.js";
import { formatSlackBlock } from "./block-message.js";
import { detectSlackViolations } from "./detect.js";

/** The gate's verdict on one Slack message body. */
export type SlackGateDecision = GateDecision;

const RELENT_PREFIX = [
	"This Slack message still has formatting the converter cannot",
	"render after a previous attempt, so it is being let through",
	"rather than blocked again. Review the remaining problems",
	"yourself:",
	"",
].join("\n");

/** Decide whether to block, relent or allow given prior block signatures. */
export function slackGateDecision(
	text: string,
	priorSignatures: string[],
): SlackGateDecision {
	const violations = detectSlackViolations(text);
	return decideGate(
		violations,
		priorSignatures,
		formatSlackBlock,
		RELENT_PREFIX,
		text,
	);
}

/**
 * The prose gate: a thin adapter over the shared loop breaker in
 * lib/gate. It supplies the prose-specific block formatting and
 * relent wording; the block-first, relent-on-repeat mechanism
 * lives in decideGate so prose and sections share one behaviour.
 */

import {
	decideGate,
	type GateDecision,
	violationSignature,
} from "../gate/index.js";
import { formatProseBlock } from "./block.js";
import type { ProseViolation } from "./detect.js";

/** Re-exported so the prose barrel exposes one signature helper. */
export { violationSignature };

/** The gate's verdict on one body of prose. */
export type ProseGateDecision = GateDecision;

const RELENT_PREFIX = [
	"This text still breaks prose-standard after a previous attempt,",
	"so it is being let through rather than blocked again. The",
	"author could not satisfy the rule automatically; review the",
	"remaining violations yourself:",
	"",
].join("\n");

/** Decide whether to block, relent or allow given prior block signatures. */
export function proseGateDecision(
	violations: ProseViolation[],
	priorSignatures: string[],
): ProseGateDecision {
	return decideGate(
		violations,
		priorSignatures,
		formatProseBlock,
		RELENT_PREFIX,
	);
}

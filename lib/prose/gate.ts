/**
 * The prose gate decision: block a violation the first time, but
 * relent if the same violation set comes back, so a model that
 * cannot satisfy the rule does not loop forever. The user is
 * surfaced the relented violations rather than trapped in a cycle.
 */

import { formatProseBlock } from "./block.js";
import type { ProseViolation } from "./detect.js";

/** The gate's verdict on one artifact. */
export interface ProseGateDecision {
	/** allow: clean. block: first offence. relent: already blocked once. */
	readonly action: "allow" | "block" | "relent";
	/** Stable signature of this violation set, for the caller to persist. */
	readonly signature: string;
	/** Message for the AI (block) or the user (relent); empty when allowed. */
	readonly message: string;
}

/** A stable, order-independent signature of a violation set. */
export function violationSignature(violations: ProseViolation[]): string {
	return violations
		.map((v) => `${v.kind}:${v.found.toLowerCase()}`)
		.sort()
		.join("|");
}

const RELENT_MESSAGE = [
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
	if (violations.length === 0) {
		return { action: "allow", signature: "", message: "" };
	}

	const signature = violationSignature(violations);
	if (priorSignatures.includes(signature)) {
		return {
			action: "relent",
			signature,
			message: RELENT_MESSAGE + formatProseBlock(violations),
		};
	}

	return { action: "block", signature, message: formatProseBlock(violations) };
}

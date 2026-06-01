/**
 * Assembles the prose gate the post action runs over a review's
 * text before it reaches GitHub. PR review comments are governed
 * by comment-format and prose-standard but pass through no
 * guardian, so this is where the same detect-and-block posture
 * is applied: detect prose violations across the review summary
 * and every comment body, block the first time with the
 * skill-grounded message, and relent on a repeat so a model that
 * cannot satisfy the rule does not loop.
 */

import type { GateDeps } from "../../lib/gate/index.js";
import {
	detectProseViolations,
	proseGateDecision,
} from "../../lib/prose/index.js";

/**
 * Build the prose gate closure for postReviewAction. Returns a
 * skill-grounded block message when the review text breaks
 * prose-standard for the first time, or undefined to let the
 * post proceed (clean text, or a relented repeat).
 */
export function buildReviewProseGate(
	deps: GateDeps,
): (texts: string[]) => string | undefined {
	return (texts) => {
		const violations = texts.flatMap(detectProseViolations);
		const decision = proseGateDecision(violations, deps.readSignatures());
		if (decision.action === "block") {
			deps.persistSignature(decision.signature);
			return decision.message;
		}
		return undefined;
	};
}

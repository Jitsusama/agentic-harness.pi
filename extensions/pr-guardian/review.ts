/**
 * PR guardian: detects gh pr create/edit commands, parses
 * title and body, and presents them for review with markdown
 * rendering.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type {
	CommandGuardian,
	GuardianResult,
} from "../../lib/guardian/types.js";
import {
	runProseGate,
	sessionProseGateDeps,
} from "../../lib/internal/guardian/prose-gate.js";
import {
	type EntityReviewConfig,
	reviewMarkdownEntity,
} from "../../lib/internal/guardian/review-entity.js";
import { isPrCommand, type PrCommand, parsePrCommand } from "./parse.js";

const PR_REVIEW_CONFIG: EntityReviewConfig = {
	createTitle: "New PR",
	editTitle: "PR Edit",
	entityLabel: "PR",
};

/**
 * Guardian that intercepts gh pr create/edit commands for review.
 *
 * Built as a factory so the review closure can capture `pi` for
 * the prose gate's session-backed signature persistence.
 */
export function createPrGuardian(pi: ExtensionAPI): CommandGuardian<PrCommand> {
	return {
		detect(command) {
			return isPrCommand(command);
		},

		parse(command) {
			return parsePrCommand(command);
		},

		async review(
			parsed: PrCommand,
			ctx: ExtensionContext,
		): Promise<GuardianResult> {
			// Block on detectable prose violations before the human
			// gate, so the user reviews a clean PR body. The gate
			// relents to the human review on a repeat to avoid looping.
			const proseBlock = runProseGate(
				sessionProseGateDeps(ctx, pi),
				parsed.body,
			);
			if (proseBlock) return proseBlock;

			return reviewMarkdownEntity(ctx, parsed, PR_REVIEW_CONFIG);
		},
	};
}

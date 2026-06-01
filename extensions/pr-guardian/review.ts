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
	sessionGateDeps,
} from "../../lib/internal/guardian/prose-gate.js";
import {
	type EntityReviewConfig,
	reviewMarkdownEntity,
} from "../../lib/internal/guardian/review-entity.js";
import { runSectionGate } from "../../lib/internal/guardian/section-gate.js";
import { PR_SECTIONS } from "../../lib/sections/index.js";
import { isPrCommand, type PrCommand, parsePrCommand } from "./parse.js";

const PR_SECTION_CONFIG = {
	sanctioned: PR_SECTIONS,
	entityLabel: "PR",
	skill: "github-pr-format",
};

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
			const deps = sessionGateDeps(ctx, pi);

			// Get the skeleton right before the prose. An invented or
			// missing section is a structural problem; there is no point
			// polishing the words in a section that should not exist, so
			// the section gate runs first.
			const sectionBlock = runSectionGate(deps, parsed.body, PR_SECTION_CONFIG);
			if (sectionBlock) return sectionBlock;

			// Block on detectable prose violations before the human
			// gate, so the user reviews a clean PR body. The gate
			// relents to the human review on a repeat to avoid looping.
			const proseBlock = runProseGate(deps, parsed.body);
			if (proseBlock) return proseBlock;

			return reviewMarkdownEntity(ctx, parsed, PR_REVIEW_CONFIG);
		},
	};
}

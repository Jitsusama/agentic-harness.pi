/**
 * PR guardian: detects gh pr create/edit commands, parses
 * title and body, and presents them for review with markdown
 * rendering.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { runProseGate } from "@jitsusama/agentic-harness.core/guardian/prose-gate";
import { runRedirectGate } from "@jitsusama/agentic-harness.core/guardian/redirect-gate";
import { runSectionGate } from "@jitsusama/agentic-harness.core/guardian/section-gate";
import { runTitleGate } from "@jitsusama/agentic-harness.core/guardian/title-gate";
import { PR_SECTIONS } from "@jitsusama/agentic-harness.core/sections";
import type {
	CommandGuardian,
	GuardianResult,
} from "../../lib/guardian/types.js";
import { sessionGateDeps } from "../../lib/internal/gate/session-deps.js";
import {
	type EntityReviewConfig,
	reviewMarkdownEntity,
} from "../../lib/internal/guardian/review-entity.js";
import { isPrCommand, type PrCommand, parsePrCommand } from "./parse.js";

const PR_SECTION_CONFIG = {
	sanctioned: PR_SECTIONS,
	entityLabel: "PR",
	skill: "github-pr-format",
};

const PR_TITLE_CONFIG = {
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

			// First, because the other gates polish a command that should not
			// be run here at all. Where something other than GitHub hosts this
			// checkout, `gh pr create` opens a change on a mirror nothing
			// reads, and every later `gh` call is blind to it.
			const redirect = await runRedirectGate(deps, {
				action: parsed.action,
				cwd: ctx.cwd,
				exec: pi.exec,
			});
			if (redirect) return redirect;

			// Get the skeleton right before the prose. An invented or
			// missing section is a structural problem; there is no point
			// polishing the words in a section that should not exist, so
			// the section gate runs first.
			const sectionBlock = runSectionGate(deps, parsed.body, PR_SECTION_CONFIG);
			if (sectionBlock) return sectionBlock;

			// The title carries its own convention (descriptive, not
			// conventional commit). Gate it before the body prose so a
			// wrong title is caught with the structure, not after.
			const titleBlock = runTitleGate(deps, parsed.title, PR_TITLE_CONFIG);
			if (titleBlock) return titleBlock;

			// Block on detectable prose violations before the human
			// gate, so the user reviews a clean PR body. The gate
			// relents to the human review on a repeat to avoid looping.
			const proseBlock = runProseGate(deps, parsed.body);
			if (proseBlock) return proseBlock;

			return reviewMarkdownEntity(ctx, parsed, PR_REVIEW_CONFIG);
		},
	};
}

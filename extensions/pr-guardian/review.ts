/**
 * PR guardian: detects gh pr create/edit commands, parses
 * title and body, and presents them for review with markdown
 * rendering.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { runProseGate } from "../../lib/core/internal/guardian/prose-gate.ts";
import { runRedirectGate } from "../../lib/core/internal/guardian/redirect-gate.ts";
import { runSectionGate } from "../../lib/core/internal/guardian/section-gate.ts";
import { runTitleGate } from "../../lib/core/internal/guardian/title-gate.ts";
import { PR_SECTIONS, PR_SHAPE } from "../../lib/core/sections/index.ts";
import { refusalUnder } from "../../lib/guardian/apply.ts";
import type {
	CommandGuardian,
	GuardianResult,
} from "../../lib/guardian/types.ts";
import { sessionGateDeps } from "../../lib/internal/gate/session-deps.ts";
import { GUARDS } from "../../lib/internal/guardian/guards.ts";
import {
	type EntityReviewConfig,
	reviewMarkdownEntity,
} from "../../lib/internal/guardian/review-entity.ts";
import { isPrCommand, type PrCommand, parsePrCommand } from "./parse.ts";

const PR_SECTION_CONFIG = {
	sanctioned: PR_SECTIONS,
	shape: PR_SHAPE,
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
	guard: GUARDS.pr.name,
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
			mode = "block",
		): Promise<GuardianResult> {
			const deps = sessionGateDeps(ctx, pi);

			// First, because the other gates polish a command that should not
			// be run here at all. Where something other than GitHub hosts this
			// checkout, `gh pr create` opens a change on a mirror nothing
			// reads, and every later `gh` call is blind to it.
			const redirect = refusalUnder(
				GUARDS.host.name,
				await runRedirectGate(deps, {
					action: parsed.action,
					cwd: ctx.cwd,
					exec: pi.exec,
				}),
				"gh pr on a host gh cannot see",
			);
			if (redirect) return redirect;

			// Get the skeleton right before the prose. An invented or
			// missing section is a structural problem; there is no point
			// polishing the words in a section that should not exist, so
			// the section gate runs first.
			const sectionBlock = refusalUnder(
				GUARDS.sections.name,
				runSectionGate(deps, parsed.body, PR_SECTION_CONFIG),
				"PR sections",
			);
			if (sectionBlock) return sectionBlock;

			// The title carries its own convention (descriptive, not
			// conventional commit). Gate it before the body prose so a
			// wrong title is caught with the structure, not after.
			const titleBlock = refusalUnder(
				GUARDS.titles.name,
				runTitleGate(deps, parsed.title, PR_TITLE_CONFIG),
				"PR title",
			);
			if (titleBlock) return titleBlock;

			// Block on detectable prose violations before the human
			// gate, so the user reviews a clean PR body. The gate
			// relents to the human review on a repeat to avoid looping.
			const proseBlock = refusalUnder(
				GUARDS.prose.name,
				runProseGate(deps, parsed.body),
				"PR prose",
			);
			if (proseBlock) return proseBlock;

			return reviewMarkdownEntity(ctx, parsed, PR_REVIEW_CONFIG, mode);
		},
	};
}

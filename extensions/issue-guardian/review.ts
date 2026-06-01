/**
 * Issue guardian: detects gh issue create/edit commands, parses
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
import { runTitleGate } from "../../lib/internal/guardian/title-gate.js";
import { ISSUE_SECTIONS } from "../../lib/sections/index.js";
import {
	type IssueCommand,
	isIssueCommand,
	parseIssueCommand,
} from "./parse.js";

const ISSUE_SECTION_CONFIG = {
	sanctioned: ISSUE_SECTIONS,
	entityLabel: "issue",
	skill: "github-issue-format",
};

const ISSUE_TITLE_CONFIG = {
	entityLabel: "issue",
	skill: "github-issue-format",
};

const ISSUE_REVIEW_CONFIG: EntityReviewConfig = {
	createTitle: "New Issue",
	editTitle: "Issue Edit",
	entityLabel: "issue",
};

/**
 * Guardian that intercepts gh issue create/edit commands for
 * review.
 *
 * Built as a factory so the review closure can capture `pi` for
 * the prose gate's session-backed signature persistence.
 */
export function createIssueGuardian(
	pi: ExtensionAPI,
): CommandGuardian<IssueCommand> {
	return {
		detect(command) {
			return isIssueCommand(command);
		},

		parse(command) {
			return parseIssueCommand(command);
		},

		async review(
			parsed: IssueCommand,
			ctx: ExtensionContext,
		): Promise<GuardianResult> {
			const deps = sessionGateDeps(ctx, pi);

			// Get the skeleton right before the prose. An invented or
			// missing section is a structural problem; there is no point
			// polishing the words in a section that should not exist, so
			// the section gate runs first.
			const sectionBlock = runSectionGate(
				deps,
				parsed.body,
				ISSUE_SECTION_CONFIG,
			);
			if (sectionBlock) return sectionBlock;

			// The title carries its own convention (descriptive, not
			// conventional commit). Gate it before the body prose so a
			// wrong title is caught with the structure, not after.
			const titleBlock = runTitleGate(deps, parsed.title, ISSUE_TITLE_CONFIG);
			if (titleBlock) return titleBlock;

			// Block on detectable prose violations before the human
			// gate, so the user reviews a clean issue body. The gate
			// relents to the human review on a repeat to avoid looping.
			const proseBlock = runProseGate(deps, parsed.body);
			if (proseBlock) return proseBlock;

			return reviewMarkdownEntity(ctx, parsed, ISSUE_REVIEW_CONFIG);
		},
	};
}

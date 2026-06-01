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
	sessionProseGateDeps,
} from "../../lib/internal/guardian/prose-gate.js";
import {
	type EntityReviewConfig,
	reviewMarkdownEntity,
} from "../../lib/internal/guardian/review-entity.js";
import {
	type IssueCommand,
	isIssueCommand,
	parseIssueCommand,
} from "./parse.js";

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
			// Block on detectable prose violations before the human
			// gate, so the user reviews a clean issue body. The gate
			// relents to the human review on a repeat to avoid looping.
			const proseBlock = runProseGate(
				sessionProseGateDeps(ctx, pi),
				parsed.body,
			);
			if (proseBlock) return proseBlock;

			return reviewMarkdownEntity(ctx, parsed, ISSUE_REVIEW_CONFIG);
		},
	};
}

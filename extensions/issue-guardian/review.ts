/**
 * Issue guardian: detects gh issue create/edit commands, parses
 * title and body, and presents them for review with markdown
 * rendering.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	type EntityReviewConfig,
	reviewMarkdownEntity,
} from "../../lib/internal/guardian/review-entity.js";
import type {
	CommandGuardian,
	GuardianResult,
} from "../../lib/internal/guardian/types.js";
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

/** Guardian that intercepts gh issue create/edit commands for review. */
export const issueGuardian: CommandGuardian<IssueCommand> = {
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
		return reviewMarkdownEntity(ctx, parsed, ISSUE_REVIEW_CONFIG);
	},
};

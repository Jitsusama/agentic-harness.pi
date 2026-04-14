/**
 * PR guardian: detects gh pr create/edit commands, parses
 * title and body, and presents them for review with markdown
 * rendering.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type {
	CommandGuardian,
	GuardianResult,
} from "../../lib/guardian/types.js";
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

/** Guardian that intercepts gh pr create/edit commands for review. */
export const prGuardian: CommandGuardian<PrCommand> = {
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
		return reviewMarkdownEntity(ctx, parsed, PR_REVIEW_CONFIG);
	},
};

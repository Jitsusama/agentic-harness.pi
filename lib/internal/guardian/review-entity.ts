/**
 * Shared review flow for markdown entities (PRs, issues).
 *
 * Both PR and issue guardians present the same interaction:
 * render a title and markdown body, offer approve/reject, and
 * translate the user's choice into a GuardianResult. This
 * module captures that concept so each guardian only supplies
 * the entity-specific labels.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	formatRedirectBlock,
	promptSingle,
	renderMarkdown,
} from "../../ui/index.js";
import { ALLOW, type GuardianResult } from "./types.js";

/** Labels that distinguish one entity type from another. */
export interface EntityReviewConfig {
	/** Display name for create mode (e.g. "New PR"). */
	readonly createTitle: string;
	/** Display name for edit mode (e.g. "PR Edit"). */
	readonly editTitle: string;
	/** Lowercase noun for context strings (e.g. "PR", "issue"). */
	readonly entityLabel: string;
}

/** The parsed fields that the review flow needs. */
export interface ReviewableEntity {
	readonly action: "create" | "edit";
	readonly title: string | null;
	readonly body: string | null;
}

const REVIEW_ACTIONS = [{ key: "r", label: "Reject" }];

/**
 * Present a markdown entity for human review and return the
 * guardian decision.
 *
 * Shows the entity's title and rendered body, offers
 * approve/reject actions, and translates the user's choice
 * (including redirects and notes) into a GuardianResult.
 */
export async function reviewMarkdownEntity(
	ctx: ExtensionContext,
	entity: ReviewableEntity,
	config: EntityReviewConfig,
): Promise<GuardianResult> {
	const panelTitle =
		entity.action === "edit" ? config.editTitle : config.createTitle;

	const result = await promptSingle(ctx, {
		title: panelTitle,
		content: (theme, width) => {
			const out: string[] = [];

			if (entity.title) {
				out.push(theme.fg("text", ` ${theme.bold(entity.title)}`));
				out.push("");
			}

			if (entity.body) {
				for (const line of renderMarkdown(entity.body, theme, width)) {
					out.push(line);
				}
			}

			return out;
		},
		actions: REVIEW_ACTIONS,
	});

	if (!result) {
		return {
			block: true,
			reason: `User cancelled the ${config.entityLabel} review.`,
		};
	}

	const redirectContext = [
		entity.title ? `Title: ${entity.title}` : null,
		"",
		entity.body ?? "",
	]
		.filter((l) => l !== null)
		.join("\n");

	const originalPrefix = `Original ${config.entityLabel}`;

	if (result.type === "redirect") {
		return formatRedirectBlock(
			result.note,
			`${originalPrefix}:\n${redirectContext}`,
		);
	}

	if (result.type === "action") {
		// Reject
		if (result.key === "r") {
			if (result.note) {
				return formatRedirectBlock(
					result.note,
					`${originalPrefix}:\n${redirectContext}`,
				);
			}
			return {
				block: true,
				reason: `User rejected the ${config.entityLabel}. Ask for guidance on the ${config.entityLabel} description.`,
			};
		}

		// Enter (approve)
		if (result.note) {
			return formatRedirectBlock(
				result.note,
				`${originalPrefix}:\n${redirectContext}`,
			);
		}
		return ALLOW;
	}
}

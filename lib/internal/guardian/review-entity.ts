/**
 * Shared review flow for markdown entities (PRs, issues).
 *
 * Both PR and issue guardians present the same interaction:
 * render a title and markdown body, offer approve/reject, and
 * translate the user's choice into a GuardianResult. This
 * module captures that concept so each guardian only supplies
 * the entity-specific labels.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	ALLOW,
	formatRedirectBlock,
	type GuardianResult,
} from "../../guardian/index.js";
import { promptSingle, renderMarkdown, wordWrap } from "../../ui/index.js";

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
 * The rows this gate draws, given a theme and the room it has.
 *
 * Pulled out of the prompt so it can be measured. This gate and the review
 * tool's gates are separate paths that draw the same kind of thing, and the
 * last time only one of them was fixed the other was reported as still
 * broken, correctly. A pure function is what lets a test hold both to the
 * same rule.
 *
 * The title is wrapped rather than emitted whole: the panel truncates what
 * overruns, and a PR title may be 72 characters, which does not fit a narrow
 * terminal beside its own leading space.
 */
export function entityGateLines(
	entity: ReviewableEntity,
	theme: Theme,
	width: number,
): string[] {
	const out: string[] = [];

	if (entity.title) {
		for (const line of wordWrap(entity.title, Math.max(1, width - 1))) {
			out.push(theme.fg("text", ` ${theme.bold(line)}`));
		}
		out.push("");
	}

	if (entity.body) {
		for (const line of renderMarkdown(entity.body, theme, width)) {
			out.push(line);
		}
	}

	return out;
}

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
	// The content gates have already run by the time we get here.
	// Without a UI there is no panel to show and no human to be the
	// backstop, so allow rather than block: the gate is the
	// enforcement, the panel is only the human review on top of it.
	if (!ctx.hasUI) return ALLOW;

	const panelTitle =
		entity.action === "edit" ? config.editTitle : config.createTitle;

	const result = await promptSingle(ctx, {
		title: panelTitle,
		content: (theme, width) => entityGateLines(entity, theme, width),
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

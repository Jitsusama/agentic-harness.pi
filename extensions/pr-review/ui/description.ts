/**
 * PR description & scope review panel.
 *
 * Shows the PR title, description, linked issue context, and
 * diff stats for the LLM and user to evaluate together.
 * Returns true to continue, false if cancelled.
 */

import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { renderMarkdown } from "../../lib/ui/content-renderer.js";
import { prompt } from "../../lib/ui/panel.js";
import { CONTENT_INDENT } from "../../lib/ui/text.js";
import type { GatheredContext } from "../state.js";

/**
 * Show the PR description & scope review panel.
 * Returns true to continue to analysis, false if cancelled.
 */
export async function showDescriptionReview(
	ctx: ExtensionContext,
	context: GatheredContext,
): Promise<boolean> {
	const result = await prompt(ctx, {
		content: (theme: Theme, width: number) => {
			const pad = " ".repeat(CONTENT_INDENT);
			const lines: string[] = [];

			lines.push(
				` ${theme.fg("accent", theme.bold("PR Description & Scope Review"))}`,
			);
			lines.push("");

			// Title
			lines.push(` ${theme.fg("text", theme.bold("Title:"))}`);
			lines.push(`${pad}${theme.fg("text", context.pr.title)}`);
			lines.push("");

			// Description
			lines.push(` ${theme.fg("text", theme.bold("Description:"))}`);
			if (context.pr.body) {
				lines.push("");
				for (const line of renderMarkdown(context.pr.body, theme, width)) {
					lines.push(line);
				}
			} else {
				lines.push(`${pad}${theme.fg("dim", "(empty)")}`);
			}
			lines.push("");

			// Diff stats
			lines.push(` ${theme.fg("text", theme.bold("Scope:"))}`);
			lines.push(
				`${pad}${theme.fg("text", `${context.pr.changedFiles} files changed`)} ${theme.fg("success", `+${context.pr.additions}`)} ${theme.fg("error", `-${context.pr.deletions}`)}`,
			);
			lines.push("");

			// Linked issues
			if (context.issues.length > 0) {
				lines.push(` ${theme.fg("text", theme.bold("Linked Issues:"))}`);
				for (const issue of context.issues) {
					lines.push(
						`${pad}${theme.fg("accent", `#${issue.number}`)} ${theme.fg("text", issue.title)} ${theme.fg("dim", `(${issue.state})`)}`,
					);
				}
			}

			return lines;
		},
		actions: [{ key: "c", label: "Continue" }],
		allowHScroll: true,
	});

	return result != null;
}

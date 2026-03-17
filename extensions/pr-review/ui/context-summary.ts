/**
 * Multi-tab context summary panel.
 *
 * Shows gathered PR context across three tabs:
 *   Overview — PR metadata, branch info, file summary
 *   Issues — linked issues with bodies and acceptance criteria
 *   PRs — related/sibling PRs
 *
 * Read-only display with 'c' to continue and Escape to cancel.
 */

import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { renderMarkdown } from "../../lib/ui/content-renderer.js";
import { prompt } from "../../lib/ui/panel.js";
import {
	CONTENT_INDENT,
	contentWrapWidth,
	wordWrap,
} from "../../lib/ui/text.js";
import type { PromptItem } from "../../lib/ui/types.js";
import type { GatheredContext } from "../state.js";

/**
 * Show the context summary panel. Returns true if the user
 * chose to continue, false if cancelled.
 */
export async function showContextSummary(
	ctx: ExtensionContext,
	context: GatheredContext,
	worktreePath: string | null,
): Promise<boolean> {
	const items: PromptItem[] = [
		buildOverviewTab(context, worktreePath),
		buildIssuesTab(context),
		buildPRsTab(context),
	];

	const result = await prompt(ctx, {
		items,
		actions: [{ key: "c", label: "Continue" }],
	});

	return result != null;
}

// ---- Tab builders ----

/** Overview tab — PR metadata, branch info, diff stats. */
function buildOverviewTab(
	context: GatheredContext,
	worktreePath: string | null,
): PromptItem {
	return {
		label: "Overview",
		views: [
			{
				key: "o",
				label: "Overview",
				content: (theme: Theme, width: number) => {
					const pad = " ".repeat(CONTENT_INDENT);
					const wrapWidth = contentWrapWidth(width);
					const lines: string[] = [];

					lines.push(
						` ${theme.fg("accent", theme.bold(`PR #${context.pr.number}: ${context.pr.title}`))}`,
					);
					lines.push(
						`${pad}${theme.fg("dim", `Author: @${context.pr.author}`)}`,
					);
					lines.push(
						`${pad}${theme.fg("dim", `Branch: ${context.pr.headRefName} → ${context.pr.baseRefName}`)}`,
					);
					lines.push(
						`${pad}${theme.fg("dim", `Files: ${context.pr.changedFiles} changed (+${context.pr.additions} -${context.pr.deletions})`)}`,
					);
					if (worktreePath) {
						lines.push(`${pad}${theme.fg("dim", `Worktree: ${worktreePath}`)}`);
					}
					lines.push("");

					lines.push(` ${theme.fg("text", theme.bold("Changed Files:"))}`);
					for (const file of context.diffFiles) {
						const stat = theme.fg(
							"dim",
							`(${file.status}, +${file.additions} -${file.deletions})`,
						);
						lines.push(`${pad}${theme.fg("text", file.path)} ${stat}`);
					}

					if (context.pr.body) {
						lines.push("");
						lines.push(` ${theme.fg("text", theme.bold("Description:"))}`);
						const bodyPreview = context.pr.body.slice(0, 500);
						const ellipsis = context.pr.body.length > 500 ? "…" : "";
						for (const line of wordWrap(
							`${bodyPreview}${ellipsis}`,
							wrapWidth,
						)) {
							lines.push(`${pad}${theme.fg("text", line)}`);
						}
					}

					return lines;
				},
			},
		],
	};
}

/** Issues tab — linked issues with bodies. */
function buildIssuesTab(context: GatheredContext): PromptItem {
	return {
		label: "Issues",
		views: [
			{
				key: "i",
				label: "Issues",
				content: (theme: Theme, width: number) => {
					const pad = " ".repeat(CONTENT_INDENT);
					const lines: string[] = [];

					if (context.issues.length === 0) {
						lines.push(`${pad}${theme.fg("dim", "No linked issues found.")}`);
						return lines;
					}

					for (const issue of context.issues) {
						lines.push(
							` ${theme.fg("accent", theme.bold(`#${issue.number}: ${issue.title}`))}`,
						);
						lines.push(`${pad}${theme.fg("dim", `State: ${issue.state}`)}`);
						if (issue.labels.length > 0) {
							lines.push(
								`${pad}${theme.fg("dim", `Labels: ${issue.labels.join(", ")}`)}`,
							);
						}

						if (issue.body) {
							lines.push("");
							for (const line of renderMarkdown(issue.body, theme, width)) {
								lines.push(line);
							}
						}

						if (issue.comments.length > 0) {
							lines.push("");
							const n = issue.comments.length;
							lines.push(
								`${pad}${theme.fg("dim", `${n} comment${n !== 1 ? "s" : ""}`)}`,
							);
						}

						lines.push("");
					}

					return lines;
				},
			},
		],
	};
}

/** PRs tab — related/sibling PRs. */
function buildPRsTab(context: GatheredContext): PromptItem {
	return {
		label: "PRs",
		views: [
			{
				key: "p",
				label: "PRs",
				content: (theme: Theme, _width: number) => {
					const pad = " ".repeat(CONTENT_INDENT);
					const lines: string[] = [];

					if (context.siblingPRs.length === 0) {
						lines.push(`${pad}${theme.fg("dim", "No related PRs found.")}`);
						return lines;
					}

					for (const pr of context.siblingPRs) {
						const stateColor = pr.state === "open" ? "success" : "dim";
						lines.push(
							` ${theme.fg("accent", `#${pr.number}`)} ${theme.fg("text", pr.title)}`,
						);
						lines.push(
							`${pad}${theme.fg(stateColor, pr.state)} · ${theme.fg("dim", pr.relationship)}`,
						);
						lines.push("");
					}

					return lines;
				},
			},
		],
	};
}

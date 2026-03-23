/**
 * UI panels: summary panel for PR overview
 * and review overview.
 *
 * Thread-level analysis and recommendations are handled by
 * the LLM directly (via the 'next' action returning context).
 * These panels handle the bookend interactions: starting and
 * wrapping up the review session.
 */

import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { promptSingle } from "../../lib/ui/panel.js";
import {
	type DependentPR,
	type ReceivedReview,
	type ReviewThread,
	threadPriority,
} from "../state.js";
import { formatFileSummary } from "./format.js";

/** Config for the PR summary panel. */
export interface SummaryPanelConfig {
	prNumber: number;
	owner: string;
	repo: string;
	branch: string;
	reviews: ReceivedReview[];
	threads: ReviewThread[];
	dismissedCount: number;
}

/**
 * Show the PR summary panel before starting review.
 * Returns true if user wants to proceed, false if cancelled.
 */
export async function showSummaryPanel(
	ctx: ExtensionContext,
	config: SummaryPanelConfig,
): Promise<boolean> {
	const { prNumber, owner, repo, branch, reviews, threads, dismissedCount } =
		config;
	const reviewers = Array.from(new Set(reviews.map((r) => r.author))).join(
		", ",
	);

	const requiredCount = threads.filter(
		(t) => threadPriority(t) === "required",
	).length;
	const optionalCount = threads.filter(
		(t) => threadPriority(t) === "optional",
	).length;
	const fileCount = new Set(threads.map((t) => t.file)).size;

	const result = await promptSingle(ctx, {
		content: (theme: Theme) => {
			const lines: string[] = [];

			lines.push(theme.fg("accent", theme.bold(`PR #${prNumber}`)));
			lines.push(theme.fg("muted", `Repository: ${owner}/${repo}`));
			lines.push(theme.fg("muted", `Branch: ${branch}`));
			lines.push("");

			lines.push(theme.fg("dim", "Review Summary:"));
			lines.push(
				`  • ${threads.length} active thread${threads.length !== 1 ? "s" : ""} across ${fileCount} file${fileCount !== 1 ? "s" : ""}`,
			);
			if (requiredCount > 0 || optionalCount > 0) {
				lines.push(
					`    (${requiredCount} required, ${optionalCount} optional)`,
				);
			}
			if (dismissedCount > 0) {
				lines.push(
					theme.fg(
						"muted",
						`  • ${dismissedCount} dismissed review${dismissedCount !== 1 ? "s" : ""} (filtered)`,
					),
				);
			}
			lines.push(`  • Reviewers: ${reviewers}`);
			lines.push("");

			lines.push(theme.fg("dim", "Files with comments:"));
			lines.push(...formatFileSummary(threads));

			return lines;
		},
	});

	return result !== null;
}

/**
 * Show a rebase confirmation panel listing dependent PRs.
 * Returns "rebase" to rebase all, "skip" to skip, or null on cancel.
 */
export async function showRebasePanel(
	ctx: ExtensionContext,
	dependents: DependentPR[],
): Promise<"rebase" | "skip" | null> {
	const result = await promptSingle(ctx, {
		content: (theme: Theme) => {
			const lines: string[] = [];

			lines.push(
				theme.fg("accent", "The following PRs are based on this branch:"),
			);
			lines.push("");

			for (const pr of dependents) {
				lines.push(`  #${pr.number}: ${pr.title} (${pr.branch})`);
			}

			lines.push("");
			lines.push(
				theme.fg("muted", "These PRs may need rebasing after your changes."),
			);

			return lines;
		},
		actions: [{ key: "p", label: "Pass" }],
	});

	if (!result) return null;
	if (result.type === "action" && result.key === "p") return "skip";
	// Enter = rebase
	return "rebase";
}

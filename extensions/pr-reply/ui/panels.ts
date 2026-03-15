/**
 * UI panels — summary panel for PR overview,
 * deferred threads summary.
 *
 * Thread-level analysis and recommendations are handled by
 * the LLM directly (via the 'next' action returning context).
 * These panels handle the bookend interactions: starting and
 * wrapping up the review session.
 */

import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { prompt } from "../../lib/ui/panel.js";
import type { Review, Thread } from "../state.js";
import { threadPriority } from "../state.js";
import { formatFileSummary } from "./format.js";

/**
 * Show the PR summary panel before starting review.
 * Returns true if user wants to proceed, false if cancelled.
 */
export async function showSummaryPanel(
	ctx: ExtensionContext,
	prNumber: number,
	owner: string,
	repo: string,
	branch: string,
	reviews: Review[],
	threads: Thread[],
	dismissedCount: number,
): Promise<boolean> {
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

	const result = await prompt(ctx, {
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
		options: [
			{ label: "Begin Review", value: "begin" },
			{ label: "Cancel", value: "cancel" },
		],
	});

	if (!result) return false;
	return result.type === "action" && result.value === "begin";
}

/**
 * Show a review overview panel — reviewer, state, body, thread list.
 * Shown once before iterating that review's threads.
 * Returns true if user wants to proceed, false if cancelled.
 */
export async function showReviewOverviewPanel(
	ctx: ExtensionContext,
	review: Review,
	pendingThreads: Thread[],
	analysis: string,
): Promise<boolean> {
	const result = await prompt(ctx, {
		content: (theme: Theme, width: number) => {
			const lines: string[] = [];

			lines.push(
				theme.fg("accent", theme.bold(`Review from ${review.author}`)),
			);
			lines.push(theme.fg("muted", `State: ${review.state}`));
			lines.push(
				theme.fg(
					"muted",
					`${pendingThreads.length} thread${pendingThreads.length !== 1 ? "s" : ""} to review`,
				),
			);
			lines.push("");

			if (review.body) {
				lines.push(theme.fg("dim", "─".repeat(Math.min(width, 40))));
				lines.push("");
				lines.push(review.body);
				lines.push("");
			}

			lines.push(theme.fg("dim", "Threads:"));
			for (const t of pendingThreads) {
				const firstComment = t.comments[0];
				const snippet = firstComment
					? firstComment.body.slice(0, 60).replace(/\n/g, " ")
					: "";
				const ellipsis = (firstComment?.body.length ?? 0) > 60 ? "…" : "";
				lines.push(`  • ${t.file}:${t.line} — ${snippet}${ellipsis}`);
			}
			lines.push("");

			if (analysis) {
				lines.push(theme.fg("dim", "─".repeat(Math.min(width, 40))));
				lines.push("");
				lines.push(analysis);
			}

			return lines;
		},
		options: [
			{ label: "Continue", value: "continue" },
			{ label: "Skip Review", value: "skip" },
		],
	});

	if (!result) return false;
	return result.type === "action" && result.value === "continue";
}

/** Dependent PR info for rebase confirmation. */
export interface DependentPR {
	number: number;
	title: string;
	branch: string;
}

/**
 * Show a rebase confirmation panel listing dependent PRs.
 * Returns "rebase" to rebase all, "skip" to skip, or null on cancel.
 */
export async function showRebasePanel(
	ctx: ExtensionContext,
	dependents: DependentPR[],
): Promise<"rebase" | "skip" | null> {
	const result = await prompt(ctx, {
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
		options: [
			{ label: "Rebase All", value: "rebase" },
			{ label: "Skip", value: "skip" },
		],
	});

	if (!result || result.type !== "action") return null;
	return result.value as "rebase" | "skip";
}

/**
 * Final vetting panel — tabbed review of all collected comments
 * before posting. One tab per comment plus a summary tab.
 *
 * Summary tab: review body, verdict, stats, post action.
 * Comment tabs: approve/reject per comment, steer to edit.
 *
 * Returns the vetting result: comment decisions, verdict,
 * review body, and whether to post immediately.
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
import type { ReviewComment, ReviewVerdict } from "../state.js";

/** Result of the vetting flow. */
export interface VettingResult {
	/** Per-comment decisions (comment ID → accepted/rejected). */
	decisions: Map<string, "accepted" | "rejected">;
	/** Final review verdict. */
	verdict: ReviewVerdict;
	/** Review body text. */
	reviewBody: string;
	/** Whether the user chose to post immediately from the panel. */
	postNow: boolean;
	/** User's steer feedback (if they broke out to edit). */
	steerFeedback?: string;
	/** Comment ID the steer was on (if specific to a comment). */
	steerCommentId?: string | null;
}

/**
 * Show the final vetting panel. Returns vetting results, or null
 * if cancelled.
 */
export async function showVetting(
	ctx: ExtensionContext,
	comments: ReviewComment[],
	suggestedVerdict: ReviewVerdict,
	draftBody: string,
): Promise<VettingResult | null> {
	if (comments.length === 0) return null;

	const items: PromptItem[] = [
		buildSummaryTab(comments, suggestedVerdict, draftBody),
		...comments.map((c, i) => buildCommentTab(c, i, comments.length)),
	];

	const result = await prompt(ctx, {
		items,
		actions: [
			{ key: "a", label: "Approve" },
			{ key: "r", label: "Reject" },
		],
		canAddItems: false,
		autoResolve: false,
	});

	if (!result) return null;

	// Check for steer on any tab
	for (const [itemIndex, itemResult] of result.items) {
		if (itemResult.type === "steer") {
			const commentIndex = itemIndex - 1;
			const comment = commentIndex >= 0 ? comments[commentIndex] : null;
			return {
				decisions: new Map(),
				verdict: suggestedVerdict,
				reviewBody: draftBody,
				postNow: false,
				steerFeedback: itemResult.note,
				steerCommentId: comment?.id ?? null,
			};
		}
	}

	// Check if the user chose to post from the summary tab
	const summaryResult = result.items.get(0);
	const postNow =
		summaryResult?.type === "action" && summaryResult.value === "p";

	// Collect per-comment decisions
	const decisions = new Map<string, "accepted" | "rejected">();

	for (const [itemIndex, itemResult] of result.items) {
		if (itemIndex === 0) continue; // Summary tab

		const commentIndex = itemIndex - 1;
		const comment = comments[commentIndex];
		if (!comment) continue;

		if (itemResult.type === "action") {
			if (itemResult.value === "a") {
				decisions.set(comment.id, "accepted");
			} else if (itemResult.value === "r") {
				decisions.set(comment.id, "rejected");
			}
		}
	}

	return {
		decisions,
		verdict: suggestedVerdict,
		reviewBody: draftBody,
		postNow,
	};
}

// ---- Tab builders ----

/** Summary tab — review body, verdict, stats, post action. */
function buildSummaryTab(
	comments: ReviewComment[],
	verdict: ReviewVerdict,
	draftBody: string,
): PromptItem {
	return {
		label: "Summary",
		views: [
			{
				key: "s",
				label: "Summary",
				content: (theme: Theme, width: number) => {
					const pad = " ".repeat(CONTENT_INDENT);
					const lines: string[] = [];

					lines.push(` ${theme.fg("accent", theme.bold("Review Summary"))}`);
					lines.push("");

					// Review body
					if (draftBody) {
						for (const line of renderMarkdown(draftBody, theme, width)) {
							lines.push(line);
						}
						lines.push("");
					}

					// Verdict
					const verdictColor =
						verdict === "APPROVE"
							? "success"
							: verdict === "REQUEST_CHANGES"
								? "error"
								: "accent";
					lines.push(
						`${pad}${theme.fg("text", "Verdict:")} ${theme.fg(verdictColor, verdict)}`,
					);
					lines.push("");

					// Comment stats
					const accepted = comments.filter(
						(c) => c.status === "accepted",
					).length;
					const rejected = comments.filter(
						(c) => c.status === "rejected",
					).length;
					const draft = comments.filter((c) => c.status === "draft").length;

					lines.push(`${pad}${theme.fg("text", "Comments:")}`);
					lines.push(
						`${pad}  ${theme.fg("success", `${accepted} accepted`)} · ${theme.fg("error", `${rejected} rejected`)} · ${theme.fg("dim", `${draft} pending`)}`,
					);
					lines.push("");

					// Label breakdown
					const labelCounts = new Map<string, number>();
					for (const c of comments) {
						labelCounts.set(c.label, (labelCounts.get(c.label) ?? 0) + 1);
					}
					const labelSummary = [...labelCounts.entries()]
						.map(([label, count]) => `${count} ${label}`)
						.join(", ");
					lines.push(`${pad}${theme.fg("dim", `Labels: ${labelSummary}`)}`);

					const files = new Set(comments.map((c) => c.file));
					lines.push(
						`${pad}${theme.fg("dim", `Files: ${files.size} with comments`)}`,
					);
					lines.push("");

					// Steer hint for editing
					lines.push(
						`${pad}${theme.fg("dim", "Use Shift+Enter to edit the verdict or review body.")}`,
					);

					return lines;
				},
			},
		],
		actions: [{ key: "p", label: "Post review" }],
	};
}

/** Individual comment tab — approve/reject with full details. */
function buildCommentTab(
	comment: ReviewComment,
	index: number,
	total: number,
): PromptItem {
	return {
		label: `C${index + 1}`,
		views: [
			{
				key: "c",
				label: "Comment",
				content: (theme: Theme, width: number) => {
					const pad = " ".repeat(CONTENT_INDENT);
					const wrapWidth = contentWrapWidth(width);
					const lines: string[] = [];

					const stateColor =
						comment.status === "accepted"
							? "success"
							: comment.status === "rejected"
								? "error"
								: "dim";

					// Header
					lines.push(
						` ${theme.fg("text", `Comment ${index + 1} of ${total}`)} ${theme.fg(stateColor, `[${comment.status}]`)}`,
					);

					// Label and location
					const decorStr =
						comment.decorations.length > 0
							? ` (${comment.decorations.join(", ")})`
							: "";
					lines.push(
						`${pad}${theme.fg("accent", `${comment.label}${decorStr}`)}`,
					);
					lines.push(
						`${pad}${theme.fg("dim", `${comment.file}:${comment.startLine}-${comment.endLine}`)}`,
					);
					lines.push("");

					// Subject
					for (const line of wordWrap(comment.subject, wrapWidth)) {
						lines.push(`${pad}${theme.fg("text", theme.bold(line))}`);
					}

					// Discussion
					if (comment.discussion) {
						lines.push("");
						for (const line of wordWrap(comment.discussion, wrapWidth)) {
							lines.push(`${pad}${theme.fg("text", line)}`);
						}
					}

					return lines;
				},
			},
		],
	};
}

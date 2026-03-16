/**
 * Final vetting panel — tabbed review of all collected comments
 * before posting. One tab per comment plus a summary tab.
 *
 * Users approve/reject each comment and set the review verdict.
 * Returns the vetting results: which comments survived and the
 * final verdict.
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
import type { CommentState, ReviewComment, ReviewVerdict } from "../state.js";

/** Result of the vetting flow. */
export interface VettingResult {
	/** Per-comment decisions (comment ID → accepted/rejected). */
	decisions: Map<string, CommentState>;
	/** Final review verdict. */
	verdict: ReviewVerdict;
	/** Review body text (may be edited by user). */
	reviewBody: string;
	/** User's steer feedback (if they broke out to edit a comment). */
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
	commentStates: Map<string, CommentState>,
	suggestedVerdict: ReviewVerdict,
	draftBody: string,
): Promise<VettingResult | null> {
	if (comments.length === 0) return null;

	const items: PromptItem[] = [
		buildSummaryTab(comments, commentStates, suggestedVerdict, draftBody),
		...comments.map((c, i) =>
			buildCommentTab(c, i, comments.length, commentStates),
		),
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

	// Check for steer results — user wants to edit a comment
	for (const [itemIndex, itemResult] of result.items) {
		if (itemResult.type === "steer") {
			const commentIndex = itemIndex - 1;
			const comment = commentIndex >= 0 ? comments[commentIndex] : null;
			return {
				decisions: commentStates,
				verdict: suggestedVerdict,
				reviewBody: draftBody,
				steerFeedback: itemResult.note,
				steerCommentId: comment?.id ?? null,
			};
		}
	}

	// Apply decisions from the tabbed prompt
	const decisions = new Map(commentStates);

	for (const [itemIndex, itemResult] of result.items) {
		// Item 0 is the summary tab — skip it
		if (itemIndex === 0) continue;

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
	};
}

// ---- Tab builders ----

/** Summary tab — overview of all comments and verdict. */
function buildSummaryTab(
	comments: ReviewComment[],
	commentStates: Map<string, CommentState>,
	verdict: ReviewVerdict,
	draftBody: string,
): PromptItem {
	return {
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
			const accepted = [...commentStates.values()].filter(
				(s) => s === "accepted",
			).length;
			const rejected = [...commentStates.values()].filter(
				(s) => s === "rejected",
			).length;
			const draft = [...commentStates.values()].filter(
				(s) => s === "draft",
			).length;

			lines.push(`${pad}${theme.fg("text", "Comments:")}`);
			lines.push(
				`${pad}  ${theme.fg("success", `${accepted} accepted`)} · ${theme.fg("error", `${rejected} rejected`)} · ${theme.fg("dim", `${draft} pending`)}`,
			);
			lines.push("");

			// Label breakdown
			const labelCounts = new Map<string, number>();
			for (const c of comments) {
				const count = labelCounts.get(c.label) ?? 0;
				labelCounts.set(c.label, count + 1);
			}
			const labelSummary = [...labelCounts.entries()]
				.map(([label, count]) => `${count} ${label}`)
				.join(", ");
			lines.push(`${pad}${theme.fg("dim", `Labels: ${labelSummary}`)}`);

			// Files covered
			const files = new Set(comments.map((c) => c.file));
			lines.push(
				`${pad}${theme.fg("dim", `Files: ${files.size} with comments`)}`,
			);

			return lines;
		},
		// Summary tab has no per-item actions — just navigation
		actions: [],
	};
}

/** Individual comment tab. */
function buildCommentTab(
	comment: ReviewComment,
	index: number,
	total: number,
	commentStates: Map<string, CommentState>,
): PromptItem {
	return {
		label: `C${index + 1}`,
		content: (theme: Theme, width: number) => {
			const pad = " ".repeat(CONTENT_INDENT);
			const wrapWidth = contentWrapWidth(width);
			const lines: string[] = [];

			const vetState = commentStates.get(comment.id) ?? "draft";
			const stateColor =
				vetState === "accepted"
					? "success"
					: vetState === "rejected"
						? "error"
						: "dim";

			// Header
			lines.push(
				` ${theme.fg("text", `Comment ${index + 1} of ${total}`)} ${theme.fg(stateColor, `[${vetState}]`)}`,
			);

			// Label and file
			const decorStr =
				comment.decorations.length > 0
					? ` (${comment.decorations.join(", ")})`
					: "";
			lines.push(`${pad}${theme.fg("accent", `${comment.label}${decorStr}`)}`);
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
	};
}

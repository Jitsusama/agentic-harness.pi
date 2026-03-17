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
import type { ReviewComment, ReviewVerdict } from "../state.js";

/** Result of the vetting flow. */
export interface VettingResult {
	/** Per-comment decisions (comment ID → accepted/rejected). */
	decisions: Map<string, "accepted" | "rejected">;
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

	// Check for steer results — user wants to edit a comment
	for (const [itemIndex, itemResult] of result.items) {
		if (itemResult.type === "steer") {
			const commentIndex = itemIndex - 1;
			const comment = commentIndex >= 0 ? comments[commentIndex] : null;
			return {
				decisions: new Map(),
				verdict: suggestedVerdict,
				reviewBody: draftBody,
				steerFeedback: itemResult.note,
				steerCommentId: comment?.id ?? null,
			};
		}
	}

	// Apply decisions from the tabbed prompt
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
	};
}

// ---- Tab builders ----

/** Summary tab — overview of all comments and verdict. */
function buildSummaryTab(
	comments: ReviewComment[],
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

			if (draftBody) {
				for (const line of renderMarkdown(draftBody, theme, width)) {
					lines.push(line);
				}
				lines.push("");
			}

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

			const accepted = comments.filter((c) => c.status === "accepted").length;
			const rejected = comments.filter((c) => c.status === "rejected").length;
			const draft = comments.filter((c) => c.status === "draft").length;

			lines.push(`${pad}${theme.fg("text", "Comments:")}`);
			lines.push(
				`${pad}  ${theme.fg("success", `${accepted} accepted`)} · ${theme.fg("error", `${rejected} rejected`)} · ${theme.fg("dim", `${draft} pending`)}`,
			);
			lines.push("");

			const labelCounts = new Map<string, number>();
			for (const c of comments) {
				const count = labelCounts.get(c.label) ?? 0;
				labelCounts.set(c.label, count + 1);
			}
			const labelSummary = [...labelCounts.entries()]
				.map(([label, count]) => `${count} ${label}`)
				.join(", ");
			lines.push(`${pad}${theme.fg("dim", `Labels: ${labelSummary}`)}`);

			const files = new Set(comments.map((c) => c.file));
			lines.push(
				`${pad}${theme.fg("dim", `Files: ${files.size} with comments`)}`,
			);

			return lines;
		},
		actions: [],
	};
}

/** Individual comment tab. */
function buildCommentTab(
	comment: ReviewComment,
	index: number,
	total: number,
): PromptItem {
	return {
		label: `C${index + 1}`,
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

			lines.push(
				` ${theme.fg("text", `Comment ${index + 1} of ${total}`)} ${theme.fg(stateColor, `[${comment.status}]`)}`,
			);

			const decorStr =
				comment.decorations.length > 0
					? ` (${comment.decorations.join(", ")})`
					: "";
			lines.push(`${pad}${theme.fg("accent", `${comment.label}${decorStr}`)}`);
			lines.push(
				`${pad}${theme.fg("dim", `${comment.file}:${comment.startLine}-${comment.endLine}`)}`,
			);
			lines.push("");

			for (const line of wordWrap(comment.subject, wrapWidth)) {
				lines.push(`${pad}${theme.fg("text", theme.bold(line))}`);
			}

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

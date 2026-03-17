/**
 * Submit panel — final review summary and confirmation.
 *
 * Single-panel showing review body, verdict, comment summary,
 * and approved comment list. User can post or steer to edit.
 */

import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { renderMarkdown } from "../../lib/ui/content-renderer.js";
import { prompt } from "../../lib/ui/panel.js";
import { CONTENT_INDENT } from "../../lib/ui/text.js";
import type { ReviewComment, ReviewSession, ReviewVerdict } from "../state.js";

/** Result from the submit panel. */
export type SubmitResult =
	| { action: "post" }
	| { action: "steer"; note: string }
	| null;

/**
 * Show the submit panel. Returns the user's choice:
 * post, steer, or null (escape).
 */
export async function showSubmitPanel(
	ctx: ExtensionContext,
	session: ReviewSession,
): Promise<SubmitResult> {
	const approved = session.comments.filter((c) => c.status === "approved");
	const rejected = session.comments.filter((c) => c.status === "rejected");
	const pending = session.comments.filter((c) => c.status === "pending");

	const result = await prompt(ctx, {
		content: (theme: Theme, width: number) => {
			const pad = " ".repeat(CONTENT_INDENT);
			const lines: string[] = [];

			// Verdict banner — prominent at the top
			const verdictColor = verdictThemeColor(session.verdict);
			const verdictLabel = verdictDisplayLabel(session.verdict);
			lines.push(
				` ${theme.fg(verdictColor, theme.bold(`━━ ${verdictLabel} ━━`))}  ${theme.fg("dim", `${session.pr.owner}/${session.pr.repo}#${session.pr.number}`)}`,
			);
			lines.push("");

			// Review body
			lines.push(` ${theme.fg("text", theme.bold("Review Body:"))}`);
			if (session.reviewBody) {
				for (const line of renderMarkdown(session.reviewBody, theme, width)) {
					lines.push(line);
				}
			} else {
				lines.push(`${pad}${theme.fg("dim", "No review body yet")}`);
			}
			lines.push("");

			// Comment summary
			lines.push(` ${theme.fg("text", theme.bold("Comments:"))}`);

			const titleCount = approved.filter((c) => c.category === "title").length;
			const scopeCount = approved.filter((c) => c.category === "scope").length;
			const fileCount = approved.filter((c) => c.category === "file").length;
			const fileSet = new Set(
				approved.filter((c) => c.file).map((c) => c.file),
			);

			lines.push(`${pad}${theme.fg("success", `${approved.length} approved`)}`);
			if (titleCount > 0) {
				lines.push(`${pad}  Title/Description: ${titleCount}`);
			}
			if (scopeCount > 0) {
				lines.push(`${pad}  Scope: ${scopeCount}`);
			}
			if (fileCount > 0) {
				lines.push(
					`${pad}  Files: ${fileCount} across ${fileSet.size} file${fileSet.size !== 1 ? "s" : ""}`,
				);
			}

			if (rejected.length > 0) {
				lines.push(
					`${pad}${theme.fg("error", `${rejected.length} rejected`)} ${theme.fg("dim", "(won't be posted)")}`,
				);
			}
			if (pending.length > 0) {
				lines.push(
					`${pad}${theme.fg("dim", `${pending.length} still pending`)}`,
				);
			}
			lines.push("");

			// Approved comment list
			if (approved.length > 0) {
				lines.push(` ${theme.fg("text", theme.bold("Approved Comments:"))}`);
				for (const c of approved) {
					lines.push(`${pad}${formatCommentOneLiner(c, theme)}`);
				}
			}

			return lines;
		},
		actions: [{ key: "p", label: "Post review" }],
		allowHScroll: true,
	});

	if (!result) return null;

	if (result.type === "steer") {
		return { action: "steer", note: result.note };
	}

	if (result.type === "action" && result.value === "p") {
		return { action: "post" };
	}

	return null;
}

// ---- Helpers ----

/** Format a comment as a one-line summary. */
function formatCommentOneLiner(comment: ReviewComment, theme: Theme): string {
	const filePart = comment.file ? `${comment.file}:` : "";
	const linePart =
		comment.startLine !== null
			? comment.startLine !== comment.endLine
				? `${comment.startLine}-${comment.endLine}`
				: `${comment.startLine}`
			: "";
	const location = `${filePart}${linePart}`;
	const decorStr =
		comment.decorations.length > 0
			? ` (${comment.decorations.join(", ")})`
			: "";

	return `${theme.fg("dim", location)} ${theme.fg("accent", comment.label)}${theme.fg("dim", decorStr)}: ${comment.subject}`;
}

/** Human-readable verdict label. */
function verdictDisplayLabel(verdict: ReviewVerdict): string {
	switch (verdict) {
		case "APPROVE":
			return "APPROVE";
		case "REQUEST_CHANGES":
			return "REQUEST CHANGES";
		default:
			return "COMMENT";
	}
}

/** Map verdict to theme color. */
function verdictThemeColor(
	verdict: ReviewVerdict,
): "success" | "error" | "accent" {
	switch (verdict) {
		case "APPROVE":
			return "success";
		case "REQUEST_CHANGES":
			return "error";
		default:
			return "accent";
	}
}

/**
 * Comment detail view: expanded single-comment display.
 *
 * Read-only view showing the full comment with file path,
 * line range, label, decorations, subject, and discussion.
 * Escape returns to the calling panel.
 */

import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { view } from "../../lib/ui/panel.js";
import {
	CONTENT_INDENT,
	contentWrapWidth,
	wordWrap,
} from "../../lib/ui/text.js";
import type { ReviewObservation } from "../state.js";

/**
 * Show a read-only comment detail view.
 * Returns when the user presses Escape.
 */
export async function showCommentDetail(
	ctx: ExtensionContext,
	comment: ReviewObservation,
): Promise<void> {
	await view(ctx, {
		title: "Comment Detail",
		content: (theme: Theme, width: number) => {
			const pad = " ".repeat(CONTENT_INDENT);
			const wrapWidth = contentWrapWidth(width);
			const lines: string[] = [];

			// Location
			if (comment.file) {
				const lineRange =
					comment.startLine !== null
						? comment.startLine !== comment.endLine
							? `:${comment.startLine}-${comment.endLine}`
							: `:${comment.startLine}`
						: "";
				lines.push(
					`${pad}${theme.fg("accent", `${comment.file}${lineRange}`)}`,
				);
				lines.push("");
			}

			// Label and decorations
			const decorStr =
				comment.decorations.length > 0
					? ` (${comment.decorations.join(", ")})`
					: "";
			lines.push(
				`${pad}${theme.fg("accent", theme.bold(`${comment.label}${decorStr}`))}`,
			);

			// Status
			const statusColor =
				comment.status === "approved"
					? "success"
					: comment.status === "rejected"
						? "error"
						: "dim";
			lines.push(
				`${pad}${theme.fg(statusColor, `[${comment.status}]`)} ${theme.fg("dim", `(${comment.source})`)}`,
			);
			lines.push("");

			// Subject
			for (const line of wordWrap(comment.subject, wrapWidth)) {
				lines.push(`${pad}${theme.fg("text", theme.bold(line))}`);
			}
			lines.push("");

			// Discussion
			if (comment.discussion) {
				for (const line of wordWrap(comment.discussion, wrapWidth)) {
					lines.push(`${pad}${theme.fg("text", line)}`);
				}
			}

			return lines;
		},
	});
}

/**
 * File review panel — shows a diff view for the current file
 * with existing comments. User can continue to next file,
 * steer to add comments, or cancel.
 *
 * Keeps the UI focused: one file at a time, diff with comment
 * markers, and action hints for navigation.
 */

import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { renderDiff } from "../../lib/ui/content-renderer.js";
import { prompt } from "../../lib/ui/panel.js";
import { CONTENT_INDENT } from "../../lib/ui/text.js";
import type { DiffFile, ReviewComment } from "../state.js";

/** Result of the file review panel. */
export type FileReviewResult =
	| { action: "next" }
	| { action: "steer"; note: string }
	| { action: "cancel" };

/**
 * Show the file review panel for a single file.
 * Returns the user's choice: next file, steer (add comments), or cancel.
 */
export async function showFileReview(
	ctx: ExtensionContext,
	file: DiffFile,
	fileIndex: number,
	fileCount: number,
	comments: ReviewComment[],
	worktreePath: string | null,
): Promise<FileReviewResult> {
	const fileComments = comments.filter((c) => c.file === file.path);

	const result = await prompt(ctx, {
		content: (theme: Theme, width: number) => {
			const pad = " ".repeat(CONTENT_INDENT);
			const lines: string[] = [];

			// Header
			lines.push(
				` ${theme.fg("accent", theme.bold(`${file.path}`))} ${theme.fg("dim", `(${fileIndex + 1}/${fileCount})`)}`,
			);
			lines.push(
				`${pad}${theme.fg("dim", `${file.status} · +${file.additions} -${file.deletions}`)}`,
			);
			if (worktreePath) {
				lines.push(
					`${pad}${theme.fg("dim", `Full file: ${worktreePath}/${file.path}`)}`,
				);
			}
			lines.push("");

			// Diff
			const diffText = buildFileDiff(file);
			if (diffText) {
				for (const line of renderDiff(diffText, theme, width)) {
					lines.push(line);
				}
			} else {
				lines.push(`${pad}${theme.fg("dim", "(no diff hunks)")}`);
			}

			// Existing comments
			if (fileComments.length > 0) {
				lines.push("");
				lines.push(
					` ${theme.fg("text", theme.bold(`Comments (${fileComments.length}):`))}`,
				);
				for (const comment of fileComments) {
					const decorStr =
						comment.decorations.length > 0
							? ` (${comment.decorations.join(", ")})`
							: "";
					lines.push(
						`${pad}${theme.fg("accent", comment.label)}${theme.fg("dim", decorStr)} L${comment.startLine}-${comment.endLine}: ${theme.fg("text", comment.subject)}`,
					);
				}
			}

			return lines;
		},
		actions: [{ key: "n", label: "Next file" }],
		allowHScroll: true,
	});

	if (!result) return { action: "cancel" };

	if (result.type === "steer") {
		return { action: "steer", note: result.note };
	}

	return { action: "next" };
}

/** Build a unified diff string from a DiffFile's hunks. */
function buildFileDiff(file: DiffFile): string | null {
	if (file.hunks.length === 0) return null;

	const lines: string[] = [];
	for (const hunk of file.hunks) {
		lines.push(hunk.header);
		for (const line of hunk.lines) {
			const prefix =
				line.type === "added" ? "+" : line.type === "removed" ? "-" : " ";
			lines.push(`${prefix}${line.content}`);
		}
	}
	return lines.join("\n");
}

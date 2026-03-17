/**
 * Tabbed file review panel — one tab per changed file.
 *
 * Each file tab has three views:
 *   d — Diff (default): unified diff with comment markers
 *   f — File: full file from worktree, syntax highlighted
 *   c — Comments: list of review comments on this file
 *
 * The user navigates files with Tab/Ctrl+#, switches views
 * with d/f/c, steers to request comments, and submits when
 * done reviewing.
 */

import * as fs from "node:fs";
import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import {
	languageFromPath,
	renderCode,
	renderDiff,
} from "../../lib/ui/content-renderer.js";
import { prompt } from "../../lib/ui/panel.js";
import {
	CONTENT_INDENT,
	contentWrapWidth,
	wordWrap,
} from "../../lib/ui/text.js";
import type { PromptItem, PromptView } from "../../lib/ui/types.js";
import type { DiffFile, ReviewComment } from "../state.js";

/** Result of the file review panel. */
export type FileReviewResult =
	| { action: "done" }
	| { action: "steer"; file: string; note: string }
	| { action: "cancel" };

/**
 * Show the tabbed file review panel. One tab per file, three
 * views per tab (diff/file/comments). Returns when the user
 * submits or cancels.
 */
export async function showFileReview(
	ctx: ExtensionContext,
	files: DiffFile[],
	comments: ReviewComment[],
	worktreePath: string | null,
): Promise<FileReviewResult> {
	const items: PromptItem[] = files.map((file, i) =>
		buildFileTab(file, i, files.length, comments, worktreePath),
	);

	const result = await prompt(ctx, {
		items,
		actions: [{ key: "n", label: "doNe" }],
		allowHScroll: true,
	});

	if (!result) return { action: "cancel" };

	for (const [itemIndex, itemResult] of result.items) {
		if (itemResult.type === "steer") {
			const file = files[itemIndex];
			return {
				action: "steer",
				file: file?.path ?? "",
				note: itemResult.note,
			};
		}
	}

	return { action: "done" };
}

// ---- Tab builder ----

/** Build one tab for a diff file with diff/file/comments views. */
function buildFileTab(
	file: DiffFile,
	index: number,
	fileCount: number,
	comments: ReviewComment[],
	worktreePath: string | null,
): PromptItem {
	const fileComments = comments.filter((c) => c.file === file.path);
	const filePath = worktreePath ? `${worktreePath}/${file.path}` : file.path;

	const views: PromptView[] = [
		buildDiffView(file, index, fileCount, fileComments, worktreePath),
		buildFileView(filePath),
		buildCommentsView(file, index, fileCount, fileComments),
	];

	return { label: shortPath(file.path), views, allowHScroll: true };
}

// ---- Views ----

/** Diff view — unified diff with comment summary. */
function buildDiffView(
	file: DiffFile,
	index: number,
	fileCount: number,
	fileComments: ReviewComment[],
	worktreePath: string | null,
): PromptView {
	return {
		key: "d",
		label: "Diff",
		content: (theme: Theme, width: number) => {
			const pad = " ".repeat(CONTENT_INDENT);
			const lines: string[] = [];

			lines.push(
				` ${theme.fg("accent", theme.bold(file.path))} ${theme.fg("dim", `(${index + 1}/${fileCount})`)}`,
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

			const diffText = buildFileDiff(file);
			if (diffText) {
				for (const line of renderDiff(diffText, theme, width)) {
					lines.push(line);
				}
			} else {
				lines.push(`${pad}${theme.fg("dim", "(no diff hunks)")}`);
			}

			if (fileComments.length > 0) {
				lines.push("");
				lines.push(
					` ${theme.fg("text", theme.bold(`Comments (${fileComments.length}):`))}`,
				);
				for (const comment of fileComments) {
					lines.push(`${pad}${formatCommentOneLiner(comment, theme)}`);
				}
			}

			return lines;
		},
	};
}

/** File view — full file content, syntax highlighted. Lazy-loaded from disk. */
function buildFileView(filePath: string): PromptView {
	return {
		key: "f",
		label: "File",
		content: async (theme: Theme, width: number) => {
			const pad = " ".repeat(CONTENT_INDENT);

			let source: string;
			try {
				source = fs.readFileSync(filePath, "utf-8");
			} catch {
				return [`${pad}${theme.fg("dim", "(file not available)")}`];
			}

			return renderCode(source, theme, width, {
				language: languageFromPath(filePath),
			});
		},
	};
}

/** Comments view — detailed list of comments on this file. */
function buildCommentsView(
	file: DiffFile,
	index: number,
	fileCount: number,
	fileComments: ReviewComment[],
): PromptView {
	return {
		key: "c",
		label: "Comments",
		content: (theme: Theme, width: number) => {
			const pad = " ".repeat(CONTENT_INDENT);
			const wrapWidth = contentWrapWidth(width);
			const lines: string[] = [];

			lines.push(
				` ${theme.fg("accent", theme.bold(file.path))} ${theme.fg("dim", `(${index + 1}/${fileCount})`)}`,
			);
			lines.push("");

			if (fileComments.length === 0) {
				lines.push(`${pad}${theme.fg("dim", "No comments on this file.")}`);
				return lines;
			}

			lines.push(
				` ${theme.fg("text", theme.bold(`${fileComments.length} comment${fileComments.length !== 1 ? "s" : ""}:`))}`,
			);
			lines.push("");

			for (const comment of fileComments) {
				const stateColor =
					comment.status === "accepted"
						? "success"
						: comment.status === "rejected"
							? "error"
							: "dim";

				const decorStr =
					comment.decorations.length > 0
						? ` (${comment.decorations.join(", ")})`
						: "";

				lines.push(
					`${pad}${theme.fg("accent", comment.label)}${theme.fg("dim", decorStr)} ${theme.fg(stateColor, `[${comment.status}]`)}`,
				);
				lines.push(
					`${pad}${theme.fg("dim", `L${comment.startLine}-${comment.endLine}`)}`,
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

				lines.push("");
			}

			return lines;
		},
	};
}

// ---- Helpers ----

/** Extract the filename from a path for use as a short tab label. */
function shortPath(path: string): string {
	const lastSlash = path.lastIndexOf("/");
	return lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
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

/** Format a comment as a one-line summary for the diff view. */
function formatCommentOneLiner(comment: ReviewComment, theme: Theme): string {
	const decorStr =
		comment.decorations.length > 0
			? ` (${comment.decorations.join(", ")})`
			: "";
	return `${theme.fg("accent", comment.label)}${theme.fg("dim", decorStr)} L${comment.startLine}-${comment.endLine}: ${theme.fg("text", comment.subject)}`;
}

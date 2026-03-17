/**
 * Tabbed file review panel — one tab per changed file.
 *
 * Shows all files as tabs with standard tab navigation.
 * Each tab shows the file's diff, status, and any existing
 * comments. The user browses freely, steers to request
 * comments, and submits when done.
 *
 * Returns the final result: completed (with any steer notes
 * collected), or cancelled.
 */

import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { renderDiff } from "../../lib/ui/content-renderer.js";
import { prompt } from "../../lib/ui/panel.js";
import { CONTENT_INDENT } from "../../lib/ui/text.js";
import type { PromptItem } from "../../lib/ui/types.js";
import type { DiffFile, ReviewComment } from "../state.js";

/** Result of the file review panel. */
export type FileReviewResult =
	| { action: "done" }
	| { action: "steer"; file: string; note: string }
	| { action: "cancel" };

/**
 * Show the tabbed file review panel. One tab per file, user
 * navigates freely. Returns when the user submits or cancels.
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
		actions: [{ key: "c", label: "Continue" }],
		allowHScroll: true,
	});

	if (!result) return { action: "cancel" };

	// Check for steer on any tab — return the first one found
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

// ---- Tab builders ----

/** Build one tab for a diff file. */
function buildFileTab(
	file: DiffFile,
	index: number,
	fileCount: number,
	comments: ReviewComment[],
	worktreePath: string | null,
): PromptItem {
	const fileComments = comments.filter((c) => c.file === file.path);

	return {
		label: shortPath(file.path),
		views: [
			{
				key: "d",
				label: "Diff",
				content: (theme: Theme, width: number) => {
					const pad = " ".repeat(CONTENT_INDENT);
					const lines: string[] = [];

					// Header
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
			},
		],
		allowHScroll: true,
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

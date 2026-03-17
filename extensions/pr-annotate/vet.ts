/**
 * Comment vetting flow — tabbed prompt where each comment is
 * a tab. Users approve/reject with hold-to-reveal annotations,
 * and add their own via '+' hotkey.
 */

import * as fs from "node:fs";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { languageFromPath, renderCode } from "../lib/ui/content-renderer.js";
import { prompt } from "../lib/ui/panel.js";
import { CONTENT_INDENT, contentWrapWidth, wordWrap } from "../lib/ui/text.js";
import type { PromptItem } from "../lib/ui/types.js";
import type { ReviewComment, VetResult } from "./index.js";

function readFileContent(
	path: string,
	startLine: number,
	endLine: number,
): string | null {
	try {
		const content = fs.readFileSync(path, "utf-8");
		const allLines = content.split("\n");
		return allLines.slice(startLine - 1, endLine).join("\n");
	} catch {
		/* File unreadable — skip code preview for this comment */
		return null;
	}
}

// ---- Item builders ----

function buildCommentItem(
	comment: ReviewComment,
	index: number,
	total: number,
	preApprovedCount: number,
): PromptItem {
	return {
		label: `C${index + 1}`,
		views: [
			{
				key: "c",
				label: "Comment",
				content: (theme, width) => {
					const wrapWidth = contentWrapWidth(width);
					const pad = " ".repeat(CONTENT_INDENT);
					const lines: string[] = [];

					const totalAll = total + preApprovedCount;
					const num = index + preApprovedCount + 1;
					lines.push(theme.fg("text", ` Comment ${num} of ${totalAll}`));

					const range = comment.startLine
						? theme.fg("dim", `:${comment.startLine}-${comment.line}`)
						: theme.fg("dim", `:${comment.line}`);
					lines.push(` ${theme.fg("accent", comment.path)}${range}`);

					// Show the actual code being commented on
					const start = comment.startLine || comment.line;
					const codeContent = readFileContent(
						comment.path,
						start,
						comment.line,
					);
					if (codeContent) {
						lines.push("");
						for (const line of renderCode(codeContent, theme, width, {
							startLine: start,
							language: languageFromPath(comment.path),
						})) {
							lines.push(line);
						}
					}

					lines.push("");
					for (const line of wordWrap(comment.body, wrapWidth)) {
						lines.push(theme.fg("text", `${pad}${line}`));
					}

					if (comment.rationale) {
						lines.push("");
						lines.push(theme.fg("dim", `${pad}Rationale:`));
						for (const line of wordWrap(comment.rationale, wrapWidth)) {
							lines.push(theme.fg("dim", `${pad}${line}`));
						}
					}

					return lines;
				},
			},
		],
		actions: [
			{ key: "a", label: "Approve" },
			{ key: "r", label: "Reject" },
		],
		allowHScroll: true,
	};
}

// ---- Main flow ----

export async function vetComments(
	comments: ReviewComment[],
	preApprovedCount: number,
	ctx: ExtensionContext,
): Promise<VetResult | null> {
	const items = comments.map((c, i) =>
		buildCommentItem(c, i, comments.length, preApprovedCount),
	);

	const result = await prompt(ctx, {
		items,
		canAddItems: true,
		autoResolve: false,
	});

	if (!result) return null;

	// Check for steer results
	for (const [, itemResult] of result.items) {
		if (itemResult.type === "steer") {
			return {
				approved: [],
				rejected: 0,
				edited: 0,
				steerFeedback: itemResult.note,
				userRequests: [],
			};
		}
	}

	// Collect results
	const approved: ReviewComment[] = [];
	let rejected = 0;

	for (let i = 0; i < comments.length; i++) {
		const itemResult = result.items.get(i);
		if (!itemResult) continue;
		const comment = comments[i];
		if (!comment) continue;

		if (itemResult.type === "action" && itemResult.value === "a") {
			approved.push(comment);
		} else if (itemResult.type === "action" && itemResult.value === "r") {
			rejected++;
		}
	}

	return {
		approved,
		rejected,
		edited: 0,
		userRequests: result.userItems,
	};
}

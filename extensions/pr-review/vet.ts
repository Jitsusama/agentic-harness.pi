/**
 * Comment vetting flow — walk through each candidate comment
 * using the shared gate, then offer to add user comments.
 *
 * Pre-approved comments (from prior rounds) are tracked in
 * the header count but not re-vetted.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { showGate } from "../shared/gate.js";
import type { ReviewComment, VetResult } from "./index.js";

const COMMENT_OPTIONS = [
	{ label: "Approve", value: "approve" },
	{ label: "Edit", value: "edit" },
	{ label: "Reject", value: "reject" },
];

const ADD_MORE_OPTIONS = [
	{ label: "Add a comment", value: "add" },
	{ label: "Done", value: "done" },
];

function wordWrap(text: string, maxWidth: number): string[] {
	if (maxWidth <= 0) return [text];
	const lines: string[] = [];
	for (const paragraph of text.split("\n")) {
		if (paragraph.length <= maxWidth) {
			lines.push(paragraph);
			continue;
		}
		let remaining = paragraph;
		while (remaining.length > maxWidth) {
			let breakAt = remaining.lastIndexOf(" ", maxWidth);
			if (breakAt <= 0) breakAt = maxWidth;
			lines.push(remaining.slice(0, breakAt));
			remaining = remaining.slice(breakAt).trimStart();
		}
		if (remaining) lines.push(remaining);
	}
	return lines;
}

function readFileLines(
	path: string,
	startLine: number,
	endLine: number,
): string[] {
	try {
		const fs = require("node:fs");
		const content = fs.readFileSync(path, "utf-8");
		const allLines = content.split("\n");
		return allLines.slice(startLine - 1, endLine);
	} catch {
		return [];
	}
}

function renderComment(
	comment: ReviewComment,
	index: number,
	total: number,
	preApprovedCount: number,
) {
	return (theme: any, width: number): string[] => {
		const indent = 2;
		const wrapWidth = width - indent;
		const pad = " ".repeat(indent);
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
		const codeLines = readFileLines(comment.path, start, comment.line);
		if (codeLines.length > 0) {
			lines.push("");
			for (let i = 0; i < codeLines.length; i++) {
				const lineNum = String(start + i).padStart(4);
				lines.push(theme.fg("dim", `${lineNum} │ `) + theme.fg("muted", codeLines[i]));
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
	};
}

function renderAddPrompt(approvedCount: number) {
	return (theme: any, _width: number): string[] => {
		const lines: string[] = [];
		lines.push(theme.fg("text", " All comments reviewed."));
		if (approvedCount > 0) {
			lines.push(theme.fg("success", ` ${approvedCount} approved so far.`));
		}
		return lines;
	};
}

export async function vetComments(
	comments: ReviewComment[],
	preApprovedCount: number,
	ctx: ExtensionContext,
): Promise<VetResult | null> {
	const approved: ReviewComment[] = [];
	const userRequests: string[] = [];
	let rejected = 0;
	let edited = 0;

	// Walk through each new comment
	for (let i = 0; i < comments.length; i++) {
		let current = { ...comments[i] };

		while (true) {
			const result = await showGate(ctx, {
				content: renderComment(current, i, comments.length, preApprovedCount),
				options: COMMENT_OPTIONS,
				steerContext: current.body,
			});

			// Escape cancels entire review
			if (!result) return null;

			if (result.value === "approve") {
				approved.push(current);
				break;
			}

			if (result.value === "edit") {
				const editedBody = await ctx.ui.editor("Edit comment:", current.body);
				if (editedBody !== undefined && editedBody.trim()) {
					current.body = editedBody.trim();
					edited++;
				}
				continue;
			}

			if (result.value === "steer") {
				return { approved: [], rejected, edited, steerFeedback: result.feedback, userRequests: [] };
			}

			// reject
			rejected++;
			break;
		}
	}

	// Offer to add user comments via natural language
	const totalApproved = preApprovedCount + approved.length;
	while (true) {
		const result = await showGate(ctx, {
			content: renderAddPrompt(totalApproved + userRequests.length),
			options: ADD_MORE_OPTIONS,
			steerContext: "",
		});

		if (!result || result.value === "done") break;

		if (result.value === "add") {
			const description = await ctx.ui.input("Describe the comment you want to add:");
			if (description?.trim()) {
				userRequests.push(description.trim());
			}
			continue;
		}

		if (result.value === "steer") {
			return { approved, rejected, edited, steerFeedback: result.feedback, userRequests };
		}
	}

	return { approved, rejected, edited, userRequests };
}

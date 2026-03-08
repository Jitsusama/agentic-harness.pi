/**
 * Comment vetting flow — tabbed panel where each comment is a
 * page. Users can freely navigate, approve/edit/reject in any
 * order, and submit when done.
 *
 * Pre-approved comments (from prior rounds) are tracked in
 * the header count but not re-vetted.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	showPanelSeries,
	type PanelPage,
	type SeriesSelection,
} from "../shared/panel.js";
import { renderCode, languageFromPath } from "../shared/content-renderer.js";
import type { ReviewComment, VetResult } from "./index.js";

// ---- Helpers ----

function wordWrap(text: string, maxWidth: number): string[] {
	if (maxWidth <= 0 || text.length <= maxWidth) return [text];
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

function readFileContent(
	path: string,
	startLine: number,
	endLine: number,
): string | null {
	try {
		const fs = require("node:fs");
		const content = fs.readFileSync(path, "utf-8");
		const allLines = content.split("\n");
		return allLines.slice(startLine - 1, endLine).join("\n");
	} catch {
		return null;
	}
}

// ---- Status indicators ----

type CommentStatus = "pending" | "approved" | "rejected" | "edited";

const STATUS_ICONS: Record<CommentStatus, string> = {
	pending: "□",
	approved: "✓",
	rejected: "✗",
	edited: "✎",
};

function statusLabel(index: number, status: CommentStatus): string {
	return `${STATUS_ICONS[status]} C${index + 1}`;
}

// ---- Page builders ----

function buildCommentPage(
	comment: ReviewComment,
	index: number,
	total: number,
	preApprovedCount: number,
	statuses: Map<number, CommentStatus>,
): PanelPage {
	const status = statuses.get(index) ?? "pending";

	return {
		label: statusLabel(index, status),
		content: (theme, width) => {
			const indent = 2;
			const cols = process.stdout.columns;
			const padded = cols && cols > 0 ? cols - 4 : 0;
			const cappedWidth = padded > 0 ? Math.min(width, padded) : width;
			const wrapWidth = cappedWidth - indent;
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
			const codeContent = readFileContent(comment.path, start, comment.line);
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
		options: [
			{ label: "Approve", value: "approve" },
			{ label: "Edit", value: "edit" },
			{ label: "Reject", value: "reject" },
			{
				label: "Steer",
				value: "steer",
				opensEditor: true,
				editorPreFill: comment.body,
			},
		],
	};
}

function buildAddDonePage(
	approvedCount: number,
	userRequestCount: number,
): PanelPage {
	return {
		label: "Done",
		content: (theme, _width) => {
			const lines: string[] = [];
			lines.push(theme.fg("text", " All comments reviewed."));
			const total = approvedCount + userRequestCount;
			if (total > 0) {
				lines.push(theme.fg("success", ` ${total} approved/added so far.`));
			}
			return lines;
		},
		options: [
			{
				label: "Add a comment",
				value: "add",
				opensEditor: true,
				editorPreFill: "",
			},
			{ label: "Done", value: "done" },
		],
	};
}

// ---- Main flow ----

export async function vetComments(
	comments: ReviewComment[],
	preApprovedCount: number,
	ctx: ExtensionContext,
): Promise<VetResult | null> {
	// Mutable state closed over by pages and onSelect
	const currentComments = comments.map((c) => ({ ...c }));
	const statuses = new Map<number, CommentStatus>();
	const userRequests: string[] = [];
	let editedCount = 0;
	let steerFeedback: string | undefined;

	// Build pages — rebuilt when tab labels need updating
	function buildPages(): PanelPage[] {
		const commentPages = currentComments.map((comment, i) =>
			buildCommentPage(
				comment, i, comments.length, preApprovedCount, statuses,
			),
		);
		const approvedCount = Array.from(statuses.values())
			.filter((s) => s === "approved" || s === "edited").length;
		const addDonePage = buildAddDonePage(
			preApprovedCount + approvedCount,
			userRequests.length,
		);
		return [...commentPages, addDonePage];
	}

	// onSelect callback — handles all actions
	async function onSelect(
		selection: SeriesSelection,
		_all: Map<number, SeriesSelection>,
	): Promise<boolean> {
		const { pageIndex, value, editorText } = selection;

		// Add/Done page
		if (pageIndex === currentComments.length) {
			if (value === "done") return true;
			if (value === "add" && editorText?.trim()) {
				userRequests.push(editorText.trim());
			}
			if (value === "steer" && editorText?.trim()) {
				steerFeedback = editorText.trim();
				return true;
			}
			return false;
		}

		// Comment page actions
		switch (value) {
			case "approve":
				statuses.set(pageIndex, "approved");
				break;

			case "edit": {
				const comment = currentComments[pageIndex]!;
				const editedBody = await ctx.ui.editor(
					"Edit comment:",
					comment.body,
				);
				if (editedBody !== undefined && editedBody.trim()) {
					comment.body = editedBody.trim();
					editedCount++;
					statuses.set(pageIndex, "edited");
				}
				break;
			}

			case "reject":
				statuses.set(pageIndex, "rejected");
				break;

			case "steer":
				if (editorText?.trim()) {
					steerFeedback = editorText.trim();
					return true;
				}
				break;
		}

		return false;
	}

	const result = await showPanelSeries(ctx, {
		pages: buildPages(),
		onSelect,
	});

	// Cancelled
	if (!result) return null;

	// Steer aborts everything
	if (steerFeedback) {
		const rejected = Array.from(statuses.values())
			.filter((s) => s === "rejected").length;
		return {
			approved: [],
			rejected,
			edited: editedCount,
			steerFeedback,
			userRequests: [],
		};
	}

	// Collect results
	const approved: ReviewComment[] = [];
	let rejected = 0;

	for (let i = 0; i < currentComments.length; i++) {
		const status = statuses.get(i) ?? "pending";
		if (status === "approved" || status === "edited") {
			approved.push(currentComments[i]!);
		} else if (status === "rejected") {
			rejected++;
		}
		// pending comments are neither approved nor rejected
	}

	return {
		approved,
		rejected,
		edited: editedCount,
		userRequests,
	};
}

/**
 * Phase 2: Review panel: Desc + Scope + file tabs with three
 * views per tab (overview/comments/raw).
 *
 * Uses the workspace prompt for stateful tabbed interaction.
 * Comment actions (approve/reject/new) are handled via
 * view-specific input handlers in comments mode.
 */

import * as fs from "node:fs";
import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey } from "@mariozechner/pi-tui";
import type { DiffFile } from "../../lib/github/diff.js";
import {
	languageFromPath,
	renderCode,
	renderDiff,
	renderMarkdown,
} from "../../lib/ui/content-renderer.js";
import { workspace } from "../../lib/ui/panel.js";
import {
	CONTENT_INDENT,
	contentWrapWidth,
	wordWrap,
} from "../../lib/ui/text.js";
import type {
	Action,
	WorkspaceInputContext,
	WorkspaceItem,
	WorkspaceResult,
	WorkspaceView,
} from "../../lib/ui/types.js";
import {
	type CrawlResult,
	commentsByCategory,
	commentsForFile,
	isTabPassed,
	markTabPassed,
	type ReviewObservation,
	type ReviewSession,
} from "../state.js";

/** Status glyphs for comments. */
const COMMENT_GLYPH = {
	pending: "●",
	approved: "◆",
	rejected: "✕",
} as const;

/** Comment mode actions. */
const COMMENT_ACTIONS: Action[] = [
	{ key: "a", label: "Approve" },
	{ key: "r", label: "Reject" },
	{ key: "n", label: "New" },
];

/** Tab pass action. */
const PASS_ACTION: Action = { key: "p", label: "Pass" };

/** Result from the review panel. */
export type ReviewPanelResult =
	| { action: "submit" }
	| {
			action: "redirect";
			note: string;
			commentId?: string;
			commentSubject?: string;
	  }
	| null;

/**
 * Show the Phase 2 review panel.
 * Returns the user's choice: submit, redirect, or null (escape).
 */
export async function showReviewPanel(
	ctx: ExtensionContext,
	session: ReviewSession,
): Promise<ReviewPanelResult> {
	const context = session.context;
	if (!context) return null;

	// We build the tab IDs for all tabs.
	const tabIds = buildTabIds(context);

	// These are mutable comment selection indices, tracked per tab.
	const commentIndices = new Map<string, number>();

	const rawItems: WorkspaceItem[] = [
		buildDescTab(ctx, session, tabIds[0] ?? "desc", commentIndices),
		buildScopeTab(ctx, session, tabIds[1] ?? "scope", commentIndices),
		...context.diffFiles.map((file, i) =>
			buildFileTab(
				ctx,
				session,
				file,
				tabIds[i + 2] ?? `file:${file.path}`,
				commentIndices,
			),
		),
	];

	// We inject 'p' handling into every view so it marks the tab
	// passed without closing the panel.
	const items = rawItems.map((item, itemIdx) => ({
		...item,
		views: item.views.map((v) => ({
			...v,
			handleInput: (data: string, inputCtx: WorkspaceInputContext) => {
				if (matchesKey(data, "p")) {
					const tabId = tabIds[itemIdx];
					if (tabId) {
						markTabPassed(session, tabId);
						inputCtx.invalidate();
					}
					return true;
				}
				return v.handleInput ? v.handleInput(data, inputCtx) : false;
			},
		})),
	}));

	const result: WorkspaceResult = await workspace(ctx, {
		items,
		globalActions: [PASS_ACTION],
		tabStatus: (index) => {
			const tabId = tabIds[index];
			if (!tabId) return "pending";
			return isTabPassed(session, tabId) ? "complete" : "pending";
		},
		allComplete: () => tabIds.every((id) => isTabPassed(session, id)),
		allowHScroll: true,
	});

	if (!result) return null;

	if (result.type === "submit") {
		return { action: "submit" };
	}

	if (result.type === "redirect") {
		return {
			action: "redirect",
			note: result.note,
		};
	}

	// This handles the 'p' action to mark the current tab passed.
	// It's passed inline via handleInput, but if it reaches here
	// it means the workspace returned an action result.
	if (result.type === "action" && result.key === "p") {
		// Tab marking is done inline via handleInput.
		return null;
	}

	return null;
}

/** Build stable tab IDs for all tabs. */
function buildTabIds(context: CrawlResult): string[] {
	return ["desc", "scope", ...context.diffFiles.map((f) => `file:${f.path}`)];
}

/** Build the Desc tab with overview/comments/raw views. */
function buildDescTab(
	ctx: ExtensionContext,
	session: ReviewSession,
	tabId: string,
	commentIndices: Map<string, number>,
): WorkspaceItem {
	const context = session.context;
	if (!context) return { label: "Desc", views: [] };

	return {
		label: "Desc",
		views: [
			buildDescOverview(context, session),
			buildCommentsView(ctx, session, tabId, "title", commentIndices),
			buildDescRaw(context),
		],
	};
}

/** Desc overview: PR title and description rendered as markdown. */
function buildDescOverview(
	context: CrawlResult,
	session: ReviewSession,
): WorkspaceView {
	return {
		key: "1",
		label: "Overview",
		content: (theme: Theme, width: number) => {
			const pad = " ".repeat(CONTENT_INDENT);
			const lines: string[] = [];

			// Title comment indicators
			const titleComments = commentsByCategory(session, "title");
			if (titleComments.length > 0) {
				lines.push(renderCommentIndicators(titleComments, theme));
				lines.push("");
			}

			lines.push(` ${theme.fg("accent", theme.bold(context.pr.title))}`);
			lines.push("");

			if (context.pr.body) {
				for (const line of renderMarkdown(context.pr.body, theme, width)) {
					lines.push(line);
				}
			} else {
				lines.push(`${pad}${theme.fg("dim", "(no description)")}`);
			}

			return lines;
		},
	};
}

/** Desc raw: raw markdown source. */
function buildDescRaw(context: CrawlResult): WorkspaceView {
	return {
		key: "3",
		label: "Source",
		content: (theme: Theme, _width: number) => {
			const pad = " ".repeat(CONTENT_INDENT);
			const lines: string[] = [];

			lines.push(` ${theme.fg("text", theme.bold("Title:"))}`);
			lines.push(`${pad}${context.pr.title}`);
			lines.push("");
			lines.push(` ${theme.fg("text", theme.bold("Description:"))}`);

			if (context.pr.body) {
				for (const line of context.pr.body.split("\n")) {
					lines.push(`${pad}${line}`);
				}
			} else {
				lines.push(`${pad}(empty)`);
			}

			return lines;
		},
	};
}

/** Build the Scope tab with overview/comments/raw views. */
function buildScopeTab(
	ctx: ExtensionContext,
	session: ReviewSession,
	tabId: string,
	commentIndices: Map<string, number>,
): WorkspaceItem {
	const context = session.context;
	if (!context) return { label: "Scope", views: [] };

	return {
		label: "Scope",
		views: [
			buildScopeOverview(session),
			buildCommentsView(ctx, session, tabId, "scope", commentIndices),
			buildScopeRaw(context),
		],
	};
}

/** Scope overview: AI-generated scope analysis. */
function buildScopeOverview(session: ReviewSession): WorkspaceView {
	return {
		key: "1",
		label: "Overview",
		content: (theme: Theme, width: number) => {
			const pad = " ".repeat(CONTENT_INDENT);

			if (!session.scopeAnalysis) {
				return [`${pad}${theme.fg("dim", "No scope analysis available.")}`];
			}

			return renderMarkdown(session.scopeAnalysis, theme, width);
		},
	};
}

/** Scope raw: file list with per-file stats. */
function buildScopeRaw(context: CrawlResult): WorkspaceView {
	return {
		key: "3",
		label: "Source",
		content: (theme: Theme, _width: number) => {
			const pad = " ".repeat(CONTENT_INDENT);
			const lines: string[] = [];

			lines.push(` ${theme.fg("text", theme.bold("Changed Files:"))}`);
			lines.push("");

			for (const file of context.diffFiles) {
				const stat = `${file.status} +${file.additions} -${file.deletions}`;
				lines.push(
					`${pad}${theme.fg("text", file.path)} ${theme.fg("dim", stat)}`,
				);
			}

			return lines;
		},
	};
}

/** Build a file tab with overview/comments/raw views. */
function buildFileTab(
	ctx: ExtensionContext,
	session: ReviewSession,
	file: DiffFile,
	tabId: string,
	commentIndices: Map<string, number>,
): WorkspaceItem {
	return {
		label: shortPath(file.path),
		views: [
			buildFileOverview(session, file),
			buildFileCommentsView(ctx, session, file, tabId, commentIndices),
			buildFileRaw(session, file),
		],
		allowHScroll: true,
	};
}

/** File overview: unified diff with comment indicators. */
function buildFileOverview(
	session: ReviewSession,
	file: DiffFile,
): WorkspaceView {
	return {
		key: "1",
		label: "Overview",
		content: (theme: Theme, width: number) => {
			const pad = " ".repeat(CONTENT_INDENT);
			const lines: string[] = [];

			lines.push(
				` ${theme.fg("accent", theme.bold(file.path))} ${theme.fg("dim", `(${file.status}, +${file.additions} -${file.deletions})`)}`,
			);
			lines.push("");

			const diffText = buildFileDiff(file);
			if (diffText) {
				const diffLines = renderDiff(diffText, theme, width);
				const fileComments = commentsForFile(session, file.path);
				const indicatorMap = buildIndicatorMap(fileComments);

				for (let i = 0; i < diffLines.length; i++) {
					const lineNum = extractLineNumber(file, i);
					const indicator = lineNum ? indicatorMap.get(lineNum) : undefined;

					if (indicator) {
						lines.push(`${indicator} ${diffLines[i]}`);
					} else {
						lines.push(`  ${diffLines[i]}`);
					}
				}
			} else {
				lines.push(`${pad}${theme.fg("dim", "(no diff hunks)")}`);
			}

			return lines;
		},
	};
}

/** File raw: full file content, syntax highlighted. */
function buildFileRaw(session: ReviewSession, file: DiffFile): WorkspaceView {
	const filePath = `${session.repoPath}/${file.path}`;

	return {
		key: "3",
		label: "Source",
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

/**
 * Build a comments view for category-based tabs (title/scope).
 * Uses comment category to filter.
 */
function buildCommentsView(
	_ctx: ExtensionContext,
	session: ReviewSession,
	tabId: string,
	category: "title" | "scope",
	commentIndices: Map<string, number>,
): WorkspaceView {
	const getIndex = () => commentIndices.get(tabId) ?? 0;
	const setIndex = (i: number) => commentIndices.set(tabId, i);

	return {
		key: "2",
		label: "Comments",
		actions: COMMENT_ACTIONS,
		content: (theme: Theme, width: number) => {
			const comments = commentsByCategory(session, category);
			return renderCommentList(comments, getIndex(), theme, width);
		},
		handleInput: (data: string, inputCtx: WorkspaceInputContext) => {
			const comments = commentsByCategory(session, category);
			return handleCommentInput(
				data,
				comments,
				getIndex,
				setIndex,
				session,
				tabId,
				inputCtx,
			);
		},
	};
}

/**
 * Build a comments view for file tabs.
 * Uses file path to filter comments.
 */
function buildFileCommentsView(
	_ctx: ExtensionContext,
	session: ReviewSession,
	file: DiffFile,
	tabId: string,
	commentIndices: Map<string, number>,
): WorkspaceView {
	const getIndex = () => commentIndices.get(tabId) ?? 0;
	const setIndex = (i: number) => commentIndices.set(tabId, i);

	return {
		key: "2",
		label: "Comments",
		actions: COMMENT_ACTIONS,
		content: (theme: Theme, width: number) => {
			const comments = commentsForFile(session, file.path);
			return renderCommentList(comments, getIndex(), theme, width);
		},
		handleInput: (data: string, inputCtx: WorkspaceInputContext) => {
			const comments = commentsForFile(session, file.path);
			return handleCommentInput(
				data,
				comments,
				getIndex,
				setIndex,
				session,
				tabId,
				inputCtx,
			);
		},
	};
}

/** Render a selectable comment list. */
function renderCommentList(
	comments: ReviewObservation[],
	selectedIndex: number,
	theme: Theme,
	width: number,
): string[] {
	const pad = " ".repeat(CONTENT_INDENT);
	const wrapWidth = contentWrapWidth(width);
	const lines: string[] = [];

	if (comments.length === 0) {
		lines.push(`${pad}${theme.fg("dim", "No comments.")}`);
		return lines;
	}

	for (let i = 0; i < comments.length; i++) {
		const c = comments[i];
		if (!c) continue;
		const isSel = i === selectedIndex;
		const cursor = isSel ? "▸ " : "  ";
		const glyph = COMMENT_GLYPH[c.status];
		const glyphColor =
			c.status === "approved"
				? "success"
				: c.status === "rejected"
					? "error"
					: "accent";

		const lineRange =
			c.startLine !== null
				? c.startLine !== c.endLine
					? `L${c.startLine}-${c.endLine}`
					: `L${c.startLine}`
				: "";

		const decorStr =
			c.decorations.length > 0 ? ` (${c.decorations.join(", ")})` : "";

		const summary = `${lineRange} ${c.label}${decorStr}: ${c.subject}`;
		const line = `${pad}${cursor}${theme.fg(glyphColor, glyph)} ${summary}`;
		lines.push(isSel ? theme.fg("accent", line) : line);

		// Expanded view for selected comment
		if (isSel) {
			lines.push("");
			if (c.discussion) {
				for (const wl of wordWrap(c.discussion, wrapWidth - 6)) {
					lines.push(`${pad}      ${theme.fg("text", wl)}`);
				}
			}
			const statusColor =
				c.status === "approved"
					? "success"
					: c.status === "rejected"
						? "error"
						: "dim";
			lines.push(
				`${pad}      ${theme.fg(statusColor, `[${c.status}]`)} ${theme.fg("dim", `(${c.source})`)}`,
			);
			lines.push("");
		}
	}

	return lines;
}

/** Handle comment mode input: navigation and actions. */
function handleCommentInput(
	data: string,
	comments: ReviewObservation[],
	getIndex: () => number,
	setIndex: (i: number) => void,
	session: ReviewSession,
	tabId: string,
	inputCtx: WorkspaceInputContext,
): boolean {
	if (comments.length === 0) {
		if (matchesKey(data, "n")) {
			inputCtx.openEditor("New comment observation:");
			return true;
		}
		return false;
	}

	// ↑↓ navigation
	if (matchesKey(data, Key.up)) {
		setIndex((getIndex() - 1 + comments.length) % comments.length);
		inputCtx.invalidate();
		inputCtx.scrollToLine(getIndex());
		return true;
	}
	if (matchesKey(data, Key.down)) {
		setIndex((getIndex() + 1) % comments.length);
		inputCtx.invalidate();
		inputCtx.scrollToLine(getIndex());
		return true;
	}

	const comment = comments[getIndex()];
	if (!comment) return false;

	// Approve
	if (matchesKey(data, "a")) {
		comment.status = "approved";
		checkTabAutoPassed(session, tabId, comments);
		advanceToNextPending(comments, getIndex, setIndex);
		inputCtx.invalidate();
		inputCtx.scrollToLine(getIndex());
		return true;
	}

	// Reject
	if (matchesKey(data, "r")) {
		comment.status = "rejected";
		checkTabAutoPassed(session, tabId, comments);
		advanceToNextPending(comments, getIndex, setIndex);
		inputCtx.invalidate();
		inputCtx.scrollToLine(getIndex());
		return true;
	}

	// New comment
	if (matchesKey(data, "n")) {
		inputCtx.openEditor("New comment observation:");
		return true;
	}

	return false;
}

/** Advance selection to the next pending comment. */
function advanceToNextPending(
	comments: ReviewObservation[],
	getIndex: () => number,
	setIndex: (i: number) => void,
): void {
	const current = getIndex();
	for (let i = 1; i <= comments.length; i++) {
		const next = (current + i) % comments.length;
		if (comments[next]?.status === "pending") {
			setIndex(next);
			return;
		}
	}
	// There are no pending comments left, so we stay at the current one.
}

/** Check if a tab should be auto-passed. */
function checkTabAutoPassed(
	session: ReviewSession,
	tabId: string,
	comments: ReviewObservation[],
): void {
	if (comments.length === 0) return;
	const allResolved = comments.every((c) => c.status !== "pending");
	if (allResolved) {
		markTabPassed(session, tabId);
	}
}

/** Render inline comment indicators for overview mode. */
function renderCommentIndicators(
	comments: ReviewObservation[],
	theme: Theme,
): string {
	const pad = " ".repeat(CONTENT_INDENT);
	const indicators: string[] = [];

	for (const c of comments) {
		const glyph = COMMENT_GLYPH[c.status];
		const color =
			c.status === "approved"
				? "success"
				: c.status === "rejected"
					? "error"
					: "accent";
		indicators.push(theme.fg(color, glyph));
	}

	return `${pad}${indicators.join(" ")} ${theme.fg("dim", `${comments.length} comment${comments.length !== 1 ? "s" : ""}`)}`;
}

/** Build a map of line number → indicator glyph for diff overlay. */
function buildIndicatorMap(comments: ReviewObservation[]): Map<number, string> {
	const map = new Map<number, string>();

	for (const c of comments) {
		if (c.startLine === null || c.endLine === null) continue;

		const glyph = COMMENT_GLYPH[c.status];
		for (let line = c.startLine; line <= c.endLine; line++) {
			// We only set this if it isn't already set (first comment wins).
			if (!map.has(line)) {
				map.set(line, glyph);
			}
		}
	}

	return map;
}

/** Try to extract the new-side line number from a diff line index. */
function extractLineNumber(
	file: DiffFile,
	displayIndex: number,
): number | null {
	let lineCount = 0;
	for (const hunk of file.hunks) {
		lineCount++; // hunk header
		for (const line of hunk.lines) {
			if (lineCount === displayIndex && line.newLineNumber !== null) {
				return line.newLineNumber;
			}
			lineCount++;
		}
	}
	return null;
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

/** Extract the filename from a path for use as a short tab label. */
function shortPath(path: string): string {
	const lastSlash = path.lastIndexOf("/");
	return lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
}

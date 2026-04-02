/**
 * Annotation vetting workspace: each file is a tab with
 * Overview (diff), Comments (selectable list), and Source
 * (full file) views.
 *
 * Comments live on the session and are mutated in place.
 * The workspace reads directly from the session's comment
 * array, so all status changes persist through redirects.
 */

import * as fs from "node:fs";
import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey } from "@mariozechner/pi-tui";
import { advanceToNextWithStatus } from "../../lib/internal/comments/navigation.js";
import { allResolved } from "../../lib/internal/comments/operations.js";
import type { DiffFile } from "../../lib/internal/github/diff.js";
import {
	type DetailEntry,
	languageFromPath,
	type NavigableItem,
	renderCode,
	renderDiff,
	renderNavigableList,
	type WorkspaceItem,
	type WorkspaceResult,
	type WorkspaceView,
	workspace,
} from "../../lib/ui/index.js";
import { handleNavigableListInput } from "../../lib/ui/navigable-list.js";
import { tabCompletion } from "../../lib/ui/tab-completion.js";
import { CONTENT_INDENT } from "../../lib/ui/text-layout.js";
import type { WorkspaceInputContext } from "../../lib/ui/types.js";
import { commentStats, commentsForFile } from "./state.js";
import type { AnnotateComment, AnnotateSession } from "./types.js";

/** Status glyphs for comments. */
const COMMENT_GLYPH = {
	pending: "●",
	approved: "◆",
	rejected: "✕",
} as const;

/** Result from the vetting workspace. */
export type ReviewResult =
	| { action: "submit" }
	| {
			action: "redirect";
			note: string;
			commentId?: string;
			commentSubject?: string;
	  }
	| null;

/**
 * Show the annotation vetting workspace. Comments are
 * mutated in place on the session — status changes
 * survive redirects and panel reloads.
 */
export async function showAnnotateWorkspace(
	ctx: ExtensionContext,
	session: AnnotateSession,
): Promise<ReviewResult> {
	if (session.comments.length === 0) {
		return { action: "submit" };
	}

	const filePaths = uniqueFilePaths(session.comments);

	// We build a diff lookup by path.
	const diffByPath = new Map<string, DiffFile>();
	for (const df of session.diffFiles) {
		diffByPath.set(df.path, df);
	}

	// Mutable selection state, tracked per tab.
	const commentIndices = new Map<string, number>();
	const tabPassed = new Set<string>();

	// We seed tab completion from existing comment statuses.
	for (const path of filePaths) {
		const fileComments = commentsForFile(session, path);
		if (allResolved(fileComments, "pending")) {
			tabPassed.add(path);
		}
	}

	const items: WorkspaceItem[] = [
		buildSummaryTab(session),
		...filePaths.map((path) =>
			buildFileTab(
				path,
				session,
				diffByPath.get(path) ?? null,
				commentIndices,
				tabPassed,
			),
		),
	];

	const tabIds = ["summary", ...filePaths];
	const completion = tabCompletion(
		tabIds,
		(id) => tabPassed.has(id),
		filePaths,
	);

	const result: WorkspaceResult = await workspace(ctx, {
		items,
		globalActions: [{ key: "p", label: "Pass" }],
		...completion,
	});

	if (!result) return null;

	if (result.type === "submit") {
		return { action: "submit" };
	}

	if (result.type === "redirect") {
		const comment = selectedComment(
			filePaths,
			session,
			commentIndices,
			result.tabIndex,
		);
		return {
			action: "redirect",
			note: result.note,
			commentId: comment?.id,
			commentSubject: comment?.subject,
		};
	}

	return null;
}

/** Build the Summary tab showing overall progress. */
function buildSummaryTab(session: AnnotateSession): WorkspaceItem {
	const summaryView: WorkspaceView = {
		key: "1",
		label: "Overview",
		content: (theme: Theme) => {
			const pad = " ".repeat(CONTENT_INDENT);
			const lines: string[] = [];
			const stats = commentStats(session);
			const total = stats.pending + stats.approved + stats.rejected;

			lines.push(` ${theme.fg("accent", theme.bold("Self-Review Comments"))}`);
			lines.push("");
			lines.push(
				`${pad}${theme.fg("text", `${total} total comment${total !== 1 ? "s" : ""}`)}`,
			);
			lines.push("");
			lines.push(
				`${pad}${theme.fg("success", `${COMMENT_GLYPH.approved} ${stats.approved} approved`)}`,
			);
			lines.push(
				`${pad}${theme.fg("error", `${COMMENT_GLYPH.rejected} ${stats.rejected} rejected`)}`,
			);
			lines.push(
				`${pad}${theme.fg("dim", `${COMMENT_GLYPH.pending} ${stats.pending} pending`)}`,
			);
			lines.push("");

			if (stats.pending > 0) {
				lines.push(
					`${pad}${theme.fg("dim", "Review all comments before posting.")}`,
				);
			} else {
				lines.push(
					`${pad}${theme.fg("success", "All comments reviewed. Press Ctrl+Enter to post.")}`,
				);
			}

			// File breakdown.
			const filePaths = uniqueFilePaths(session.comments);
			if (filePaths.length > 0) {
				lines.push("");
				lines.push(` ${theme.fg("text", theme.bold("Files:"))}`);
				for (const file of filePaths) {
					const fc = commentsForFile(session, file);
					const fa = fc.filter((c) => c.status === "approved").length;
					const fr = fc.filter((c) => c.status === "rejected").length;
					const fp = fc.filter((c) => c.status === "pending").length;
					lines.push(
						`${pad}${theme.fg("text", file)} ${theme.fg("dim", `(${fa}✓ ${fr}✕ ${fp}○)`)}`,
					);
				}
			}

			return lines;
		},
	};

	return { label: "Summary", views: [summaryView] };
}

/** Build a file tab with Overview (diff), Comments and Source views. */
function buildFileTab(
	filePath: string,
	session: AnnotateSession,
	diffFile: DiffFile | null,
	commentIndices: Map<string, number>,
	tabPassed: Set<string>,
): WorkspaceItem {
	const getIndex = () => commentIndices.get(filePath) ?? 0;
	const setIndex = (i: number) => commentIndices.set(filePath, i);

	return {
		label: shortPath(filePath),
		views: [
			buildOverviewView(filePath, session, diffFile),
			buildCommentsView(filePath, session, getIndex, setIndex, tabPassed),
			buildSourceView(filePath),
		],
	};
}

/** Overview view: diff with comment indicators on annotated lines. */
function buildOverviewView(
	filePath: string,
	session: AnnotateSession,
	diffFile: DiffFile | null,
): WorkspaceView {
	return {
		key: "1",
		label: "Overview",
		allowHScroll: true,
		content: (theme: Theme, width: number) => {
			const pad = " ".repeat(CONTENT_INDENT);
			const lines: string[] = [];
			const fileComments = commentsForFile(session, filePath);

			const status = diffFile?.status ?? "modified";
			const additions = diffFile?.additions ?? 0;
			const deletions = diffFile?.deletions ?? 0;

			lines.push(
				` ${theme.fg("accent", theme.bold(filePath))} ${theme.fg("dim", `(${status}, +${additions} -${deletions})`)}`,
			);
			lines.push("");

			if (fileComments.length > 0) {
				lines.push(renderCommentIndicators(fileComments, theme));
				lines.push("");
			}

			const diffText = diffFile ? buildFileDiff(diffFile) : null;
			if (diffText) {
				const diffLines = renderDiff(diffText, theme, width);
				const indicatorMap = buildIndicatorMap(fileComments, diffFile);

				for (let i = 0; i < diffLines.length; i++) {
					const lineNum = diffFile ? extractLineNumber(diffFile, i) : null;
					const indicator = lineNum ? indicatorMap.get(lineNum) : undefined;
					lines.push(
						indicator ? `${indicator} ${diffLines[i]}` : `  ${diffLines[i]}`,
					);
				}
			} else {
				lines.push(`${pad}${theme.fg("dim", "(no diff available)")}`);
			}

			return lines;
		},
	};
}

/** Comments view: selectable list with approve/reject actions. */
function buildCommentsView(
	filePath: string,
	session: AnnotateSession,
	getIndex: () => number,
	setIndex: (i: number) => void,
	tabPassed: Set<string>,
): WorkspaceView {
	return {
		key: "2",
		label: "Comments",
		actions: [
			{ key: "r", label: "Reject" },
			{ key: "n", label: "New" },
		],
		enterHint: "approve",
		content: (theme: Theme, width: number) => {
			const comments = commentsForFile(session, filePath);
			return renderCommentList(comments, getIndex(), theme, width);
		},
		handleInput: (data: string, inputCtx: WorkspaceInputContext) => {
			const comments = commentsForFile(session, filePath);

			// Pass: mark this tab as reviewed.
			if (matchesKey(data, "p")) {
				tabPassed.add(filePath);
				inputCtx.invalidate();
				return true;
			}

			if (comments.length === 0) {
				if (matchesKey(data, "n")) {
					inputCtx.openEditor("New comment for this file:");
					return true;
				}
				return false;
			}

			// ↑↓ navigation
			const navResult = handleNavigableListInput(
				data,
				getIndex(),
				comments.length,
			);
			if (navResult !== null) {
				setIndex(navResult);
				inputCtx.invalidate();
				inputCtx.scrollToContentLine(navResult);
				return true;
			}

			const comment = comments[getIndex()];
			if (!comment) return false;

			// Approve (Enter)
			if (matchesKey(data, Key.enter)) {
				comment.status = "approved";
				checkTabAutoPassed(filePath, comments, tabPassed);
				const next = advanceToNextWithStatus(comments, getIndex(), "pending");
				if (next !== null) setIndex(next);
				inputCtx.invalidate();
				inputCtx.scrollToContentLine(getIndex());
				return true;
			}

			// Reject
			if (matchesKey(data, "r")) {
				comment.status = "rejected";
				checkTabAutoPassed(filePath, comments, tabPassed);
				const next = advanceToNextWithStatus(comments, getIndex(), "pending");
				if (next !== null) setIndex(next);
				inputCtx.invalidate();
				inputCtx.scrollToContentLine(getIndex());
				return true;
			}

			// New comment
			if (matchesKey(data, "n")) {
				inputCtx.openEditor("New comment for this file:");
				return true;
			}

			return false;
		},
	};
}

/** Source view: full file content, syntax highlighted. */
function buildSourceView(filePath: string): WorkspaceView {
	return {
		key: "3",
		label: "Source",
		allowHScroll: true,
		content: (theme: Theme, width: number) => {
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

/** Map an annotation comment to a NavigableItem. */
function commentToItem(c: AnnotateComment, theme: Theme): NavigableItem {
	const glyphColor =
		c.status === "approved"
			? "success"
			: c.status === "rejected"
				? "error"
				: "accent";

	const lineRange = c.startLine ? `L${c.startLine}-${c.line}` : `L${c.line}`;
	const statusColor =
		c.status === "approved"
			? "success"
			: c.status === "rejected"
				? "error"
				: "dim";

	const detail: DetailEntry[] = [""];
	detail.push({ text: c.body, color: "text" });
	if (c.rationale) {
		detail.push("");
		detail.push({ text: "Rationale:", color: "dim" });
		detail.push({ text: c.rationale, color: "dim" });
	}
	detail.push(theme.fg(statusColor, `[${c.status}]`));
	detail.push("");

	return {
		glyph: theme.fg(glyphColor, COMMENT_GLYPH[c.status]),
		summary: `${lineRange}: ${c.subject ?? c.body.split("\n")[0]}`,
		detail,
	};
}

/** Render a selectable comment list. */
function renderCommentList(
	comments: AnnotateComment[],
	selectedIndex: number,
	theme: Theme,
	width: number,
): string[] {
	const items = comments.map((c) => commentToItem(c, theme));
	const { lines } = renderNavigableList(
		items,
		selectedIndex,
		theme,
		{ emptyMessage: "No comments for this file." },
		width,
	);
	return lines;
}

/** Get sorted unique file paths from the comment list. */
function uniqueFilePaths(comments: AnnotateComment[]): string[] {
	return [...new Set(comments.map((c) => c.path))].sort();
}

/** Extract filename from a path for tab labels. */
function shortPath(path: string): string {
	const lastSlash = path.lastIndexOf("/");
	return lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
}

/** Auto-mark tab as passed when all comments have been resolved. */
function checkTabAutoPassed(
	filePath: string,
	comments: AnnotateComment[],
	tabPassed: Set<string>,
): void {
	if (allResolved(comments, "pending")) {
		tabPassed.add(filePath);
	}
}

/** Render inline comment indicators. */
function renderCommentIndicators(
	comments: AnnotateComment[],
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
function buildIndicatorMap(
	comments: AnnotateComment[],
	diffFile: DiffFile | null,
): Map<number, string> {
	const map = new Map<number, string>();
	if (!diffFile) return map;

	for (const c of comments) {
		const start = c.startLine ?? c.line;
		const end = c.line;
		const glyph = COMMENT_GLYPH[c.status];

		for (let line = start; line <= end; line++) {
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

/**
 * Resolve the comment the user was viewing when they redirected.
 * Tab layout: [summary, file0, file1, ...].
 */
function selectedComment(
	filePaths: string[],
	session: AnnotateSession,
	commentIndices: Map<string, number>,
	tabIndex: number,
): AnnotateComment | null {
	// Tab 0 is the summary tab — no associated comment.
	const fileIdx = tabIndex - 1;
	const filePath = filePaths[fileIdx];
	if (!filePath) return null;

	const comments = commentsForFile(session, filePath);
	const idx = commentIndices.get(filePath) ?? 0;
	return comments[idx] ?? null;
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

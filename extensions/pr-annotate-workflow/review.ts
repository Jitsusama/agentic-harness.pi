/**
 * Comment vetting flow: workspace prompt where each file is
 * a tab with Overview (diff), Comments (selectable list), and
 * Source (full file) views. Mirrors pr-review's review panel.
 */

import * as fs from "node:fs";
import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey } from "@mariozechner/pi-tui";
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
import type { ProposedComment, VetResult } from "./types.js";

/** Status glyphs for comments. */
const COMMENT_GLYPH = {
	pending: "●",
	approved: "◆",
	rejected: "✕",
} as const;

/** Comment status type. */
type CommentStatus = "pending" | "approved" | "rejected";

/** Internal comment with mutable status for the workspace. */
interface VetComment {
	comment: ProposedComment;
	status: CommentStatus;
}

/**
 * Show the vetting workspace. Returns approved/rejected counts,
 * user requests, and redirect feedback. Returns null on cancel.
 */
export async function reviewProposedComments(
	comments: ProposedComment[],
	preApprovedCount: number,
	ctx: ExtensionContext,
	diffFiles: DiffFile[],
): Promise<VetResult | null> {
	if (comments.length === 0 && preApprovedCount === 0) {
		return { approved: [], rejected: 0, edited: 0, userRequests: [] };
	}

	// We wrap each comment with mutable status tracking.
	const trackedComments: VetComment[] = comments.map((c) => ({
		comment: c,
		status: "pending" as CommentStatus,
	}));

	// We group comments by file path.
	const fileGroups = groupByFile(trackedComments);
	const filePaths = [...fileGroups.keys()].sort();

	// We build a diff lookup by path.
	const diffByPath = new Map<string, DiffFile>();
	for (const df of diffFiles) {
		diffByPath.set(df.path, df);
	}

	// This is mutable selection state, tracked per tab.
	const commentIndices = new Map<string, number>();
	const tabPassed = new Set<string>();

	// We build the workspace items from the summary and file tabs.
	const items: WorkspaceItem[] = [
		buildSummaryTab(trackedComments, preApprovedCount),
		...filePaths.map((path) =>
			buildFileTab(
				path,
				fileGroups.get(path) ?? [],
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

	if (result.type === "redirect") {
		// A redirect could be feedback on a comment or a request for
		// a new one. Either way, we return it as redirect feedback
		// and let the LLM interpret the intent. We include any
		// already-approved comments so they aren't lost.
		const approved: ProposedComment[] = [];
		for (const vc of trackedComments) {
			if (vc.status === "approved") {
				approved.push(vc.comment);
			}
		}

		// Resolve which comment the user was looking at.
		const activeComment = selectedVetComment(
			filePaths,
			fileGroups,
			commentIndices,
			result.tabIndex,
		);

		return {
			approved,
			rejected: 0,
			edited: 0,
			redirectFeedback: result.note,
			redirectComment: activeComment?.comment,
			userRequests: [],
		};
	}

	// We collect the results when the user submits via Ctrl+Enter.
	const approved: ProposedComment[] = [];
	let rejected = 0;

	for (const vc of trackedComments) {
		if (vc.status === "approved") {
			approved.push(vc.comment);
		} else if (vc.status === "rejected") {
			rejected++;
		}
	}

	return {
		approved,
		rejected,
		edited: 0,
		userRequests: [],
	};
}

/** Build the Summary tab showing overall progress and post action. */
function buildSummaryTab(
	trackedComments: VetComment[],
	preApprovedCount: number,
): WorkspaceItem {
	const summaryView: WorkspaceView = {
		key: "1",
		label: "Overview",
		content: (theme: Theme) => {
			const pad = " ".repeat(CONTENT_INDENT);
			const lines: string[] = [];

			const total = trackedComments.length + preApprovedCount;
			const approved =
				trackedComments.filter((c) => c.status === "approved").length +
				preApprovedCount;
			const rejected = trackedComments.filter(
				(c) => c.status === "rejected",
			).length;
			const pending = trackedComments.filter(
				(c) => c.status === "pending",
			).length;

			lines.push(` ${theme.fg("accent", theme.bold("Self-Review Comments"))}`);
			lines.push("");
			lines.push(
				`${pad}${theme.fg("text", `${total} total comment${total !== 1 ? "s" : ""}`)}`,
			);
			if (preApprovedCount > 0) {
				lines.push(
					`${pad}${theme.fg("dim", `${preApprovedCount} pre-approved from prior round`)}`,
				);
			}
			lines.push("");
			lines.push(
				`${pad}${theme.fg("success", `${COMMENT_GLYPH.approved} ${approved} approved`)}`,
			);
			lines.push(
				`${pad}${theme.fg("error", `${COMMENT_GLYPH.rejected} ${rejected} rejected`)}`,
			);
			lines.push(
				`${pad}${theme.fg("dim", `${COMMENT_GLYPH.pending} ${pending} pending`)}`,
			);
			lines.push("");

			if (pending > 0) {
				lines.push(
					`${pad}${theme.fg("dim", "Review all comments before posting.")}`,
				);
			} else {
				lines.push(
					`${pad}${theme.fg("success", "All comments reviewed. Press Ctrl+Enter to post.")}`,
				);
			}

			// File breakdown
			const files = new Set(trackedComments.map((c) => c.comment.path));
			if (files.size > 0) {
				lines.push("");
				lines.push(` ${theme.fg("text", theme.bold("Files:"))}`);
				for (const file of [...files].sort()) {
					const fileComments = trackedComments.filter(
						(c) => c.comment.path === file,
					);
					const fa = fileComments.filter((c) => c.status === "approved").length;
					const fr = fileComments.filter((c) => c.status === "rejected").length;
					const fp = fileComments.filter((c) => c.status === "pending").length;
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
	fileComments: VetComment[],
	diffFile: DiffFile | null,
	commentIndices: Map<string, number>,
	tabPassed: Set<string>,
): WorkspaceItem {
	const getIndex = () => commentIndices.get(filePath) ?? 0;
	const setIndex = (i: number) => commentIndices.set(filePath, i);

	return {
		label: shortPath(filePath),
		views: [
			buildOverviewView(filePath, fileComments, diffFile),
			buildCommentsView(filePath, fileComments, getIndex, setIndex, tabPassed),
			buildSourceView(filePath),
		],
	};
}

/** Overview view: diff with comment indicators on annotated lines. */
function buildOverviewView(
	filePath: string,
	fileComments: VetComment[],
	diffFile: DiffFile | null,
): WorkspaceView {
	return {
		key: "1",
		label: "Overview",
		allowHScroll: true,
		content: (theme: Theme, width: number) => {
			const pad = " ".repeat(CONTENT_INDENT);
			const lines: string[] = [];

			const status = diffFile?.status ?? "modified";
			const additions = diffFile?.additions ?? 0;
			const deletions = diffFile?.deletions ?? 0;

			lines.push(
				` ${theme.fg("accent", theme.bold(filePath))} ${theme.fg("dim", `(${status}, +${additions} -${deletions})`)}`,
			);
			lines.push("");

			// Comment indicators
			if (fileComments.length > 0) {
				lines.push(renderCommentIndicators(fileComments, theme));
				lines.push("");
			}

			// We render the diff if one is available.
			const diffText = diffFile ? buildFileDiff(diffFile) : null;
			if (diffText) {
				const diffLines = renderDiff(diffText, theme, width);
				const indicatorMap = buildIndicatorMap(fileComments, diffFile);

				for (let i = 0; i < diffLines.length; i++) {
					const lineNum = diffFile ? extractLineNumber(diffFile, i) : null;
					const indicator = lineNum ? indicatorMap.get(lineNum) : undefined;

					if (indicator) {
						lines.push(`${indicator} ${diffLines[i]}`);
					} else {
						lines.push(`  ${diffLines[i]}`);
					}
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
	fileComments: VetComment[],
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
			return renderCommentList(fileComments, getIndex(), theme, width);
		},
		handleInput: (data: string, inputCtx: WorkspaceInputContext) => {
			// Pass: mark this tab as reviewed.
			if (matchesKey(data, "p")) {
				tabPassed.add(filePath);
				inputCtx.invalidate();
				return true;
			}

			if (fileComments.length === 0) {
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
				fileComments.length,
			);
			if (navResult !== null) {
				setIndex(navResult);
				inputCtx.invalidate();
				inputCtx.scrollToContentLine(navResult);
				return true;
			}

			const vc = fileComments[getIndex()];
			if (!vc) return false;

			// Approve (Enter)
			if (matchesKey(data, Key.enter)) {
				vc.status = "approved";
				checkTabAutoPassed(filePath, fileComments, tabPassed);
				advanceToNextPending(fileComments, getIndex, setIndex);
				inputCtx.invalidate();
				inputCtx.scrollToContentLine(getIndex());
				return true;
			}

			// Reject
			if (matchesKey(data, "r")) {
				vc.status = "rejected";
				checkTabAutoPassed(filePath, fileComments, tabPassed);
				advanceToNextPending(fileComments, getIndex, setIndex);
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

/** Map a vet comment to a NavigableItem. */
function vetCommentToItem(vc: VetComment, theme: Theme): NavigableItem {
	const c = vc.comment;
	const glyphColor =
		vc.status === "approved"
			? "success"
			: vc.status === "rejected"
				? "error"
				: "accent";

	const lineRange = c.startLine ? `L${c.startLine}-${c.line}` : `L${c.line}`;
	const statusColor =
		vc.status === "approved"
			? "success"
			: vc.status === "rejected"
				? "error"
				: "dim";

	const detail: DetailEntry[] = [""];
	detail.push({ text: c.body, color: "text" });
	if (c.rationale) {
		detail.push("");
		detail.push({ text: "Rationale:", color: "dim" });
		detail.push({ text: c.rationale, color: "dim" });
	}
	detail.push(theme.fg(statusColor, `[${vc.status}]`));
	detail.push("");

	return {
		glyph: theme.fg(glyphColor, COMMENT_GLYPH[vc.status]),
		summary: `${lineRange}: ${c.subject ?? c.body.split("\n")[0]}`,
		detail,
	};
}

/** Render a selectable comment list. */
function renderCommentList(
	comments: VetComment[],
	selectedIndex: number,
	theme: Theme,
	width: number,
): string[] {
	const items = comments.map((vc) => vetCommentToItem(vc, theme));
	const { lines } = renderNavigableList(
		items,
		selectedIndex,
		theme,
		{ emptyMessage: "No comments for this file." },
		width,
	);
	return lines;
}

/** Group comments by file path, preserving order. */
function groupByFile(comments: VetComment[]): Map<string, VetComment[]> {
	const groups = new Map<string, VetComment[]>();
	for (const vc of comments) {
		const path = vc.comment.path;
		if (!groups.has(path)) groups.set(path, []);
		groups.get(path)?.push(vc);
	}
	return groups;
}

/** Extract filename from a path for tab labels. */
function shortPath(path: string): string {
	const lastSlash = path.lastIndexOf("/");
	return lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
}

/** Advance selection to the next pending comment. */
function advanceToNextPending(
	comments: VetComment[],
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
}

/** Auto-mark tab as passed when all comments are resolved. */
function checkTabAutoPassed(
	filePath: string,
	comments: VetComment[],
	tabPassed: Set<string>,
): void {
	const allResolved = comments.every((c) => c.status !== "pending");
	if (allResolved) {
		tabPassed.add(filePath);
	}
}

/** Render inline comment indicators. */
function renderCommentIndicators(comments: VetComment[], theme: Theme): string {
	const pad = " ".repeat(CONTENT_INDENT);
	const indicators: string[] = [];

	for (const vc of comments) {
		const glyph = COMMENT_GLYPH[vc.status];
		const color =
			vc.status === "approved"
				? "success"
				: vc.status === "rejected"
					? "error"
					: "accent";
		indicators.push(theme.fg(color, glyph));
	}

	return `${pad}${indicators.join(" ")} ${theme.fg("dim", `${comments.length} comment${comments.length !== 1 ? "s" : ""}`)}`;
}

/** Build a map of line number → indicator glyph for diff overlay. */
function buildIndicatorMap(
	comments: VetComment[],
	diffFile: DiffFile | null,
): Map<number, string> {
	const map = new Map<number, string>();
	if (!diffFile) return map;

	for (const vc of comments) {
		const c = vc.comment;
		const start = c.startLine ?? c.line;
		const end = c.line;
		const glyph = COMMENT_GLYPH[vc.status];

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
 * Tab layout: [summary, file0, file1, ...]. Tab 0 (summary)
 * has no comments.
 */
function selectedVetComment(
	filePaths: string[],
	fileGroups: Map<string, VetComment[]>,
	commentIndices: Map<string, number>,
	tabIndex: number,
): VetComment | null {
	// Tab 0 is the summary tab — no associated comment.
	const fileIdx = tabIndex - 1;
	const filePath = filePaths[fileIdx];
	if (!filePath) return null;

	const comments = fileGroups.get(filePath) ?? [];
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

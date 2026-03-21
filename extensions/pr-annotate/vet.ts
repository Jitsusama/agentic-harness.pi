/**
 * Comment vetting flow — workspace prompt where each file is
 * a tab with Overview (diff), Comments (selectable list), and
 * Source (full file) views. Mirrors pr-review's review panel.
 */

import * as fs from "node:fs";
import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey } from "@mariozechner/pi-tui";
import type { DiffFile } from "../lib/github/diff.js";
import { matchesActionKey } from "../lib/ui/action-bar.js";
import {
	languageFromPath,
	renderCode,
	renderDiff,
} from "../lib/ui/content-renderer.js";
import { workspace } from "../lib/ui/panel.js";
import { CONTENT_INDENT, contentWrapWidth, wordWrap } from "../lib/ui/text.js";
import type {
	WorkspaceInputContext,
	WorkspaceItem,
	WorkspaceResult,
	WorkspaceView,
} from "../lib/ui/types.js";
import type { ReviewComment, VetResult } from "./index.js";

// ---- Constants ----

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
	comment: ReviewComment;
	status: CommentStatus;
}

// ---- Public API ----

/**
 * Show the vetting workspace. Returns approved/rejected counts,
 * user requests, and steer feedback. Returns null on cancel.
 */
export async function vetComments(
	comments: ReviewComment[],
	preApprovedCount: number,
	ctx: ExtensionContext,
	diffFiles: DiffFile[],
): Promise<VetResult | null> {
	if (comments.length === 0 && preApprovedCount === 0) {
		return { approved: [], rejected: 0, edited: 0, userRequests: [] };
	}

	// Wrap comments with mutable status
	const vetComments: VetComment[] = comments.map((c) => ({
		comment: c,
		status: "pending" as CommentStatus,
	}));

	// Group comments by file path
	const fileGroups = groupByFile(vetComments);
	const filePaths = [...fileGroups.keys()].sort();

	// Build diff lookup
	const diffByPath = new Map<string, DiffFile>();
	for (const df of diffFiles) {
		diffByPath.set(df.path, df);
	}

	// Mutable selection state per tab
	const commentIndices = new Map<string, number>();
	const tabHandled = new Set<string>();

	// Build workspace items
	const items: WorkspaceItem[] = [
		buildSummaryTab(vetComments, preApprovedCount),
		...filePaths.map((path) =>
			buildFileTab(
				path,
				fileGroups.get(path) ?? [],
				diffByPath.get(path) ?? null,
				commentIndices,
				tabHandled,
			),
		),
	];

	const tabIds = ["summary", ...filePaths];

	const result: WorkspaceResult = await workspace(ctx, {
		items,
		globalActions: [{ key: "h", label: "Handled" }],
		tabStatus: (index) => {
			const tabId = tabIds[index];
			if (!tabId) return "pending";
			if (tabId === "summary") return "pending";
			return tabHandled.has(tabId) ? "complete" : "pending";
		},
		allComplete: () => filePaths.every((p) => tabHandled.has(p)),
		allowHScroll: true,
	});

	if (!result) return null;

	if (result.type === "steer") {
		// Steer could be feedback on a comment or a request for a new
		// comment (from the '+' action). Either way, return it as steer
		// feedback — the LLM can interpret the intent.
		// Include any already-approved comments so they aren't lost.
		const approved: ReviewComment[] = [];
		for (const vc of vetComments) {
			if (vc.status === "approved") {
				approved.push(vc.comment);
			}
		}
		return {
			approved,
			rejected: 0,
			edited: 0,
			steerFeedback: result.note,
			userRequests: [],
		};
	}

	// Collect results (submit via Ctrl+Enter)
	const approved: ReviewComment[] = [];
	let rejected = 0;

	for (const vc of vetComments) {
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

// ---- Summary tab ----

/** Build the Summary tab showing overall progress and post action. */
function buildSummaryTab(
	vetComments: VetComment[],
	preApprovedCount: number,
): WorkspaceItem {
	const summaryView: WorkspaceView = {
		key: "o",
		label: "Overview",
		content: (theme: Theme) => {
			const pad = " ".repeat(CONTENT_INDENT);
			const lines: string[] = [];

			const total = vetComments.length + preApprovedCount;
			const approved =
				vetComments.filter((c) => c.status === "approved").length +
				preApprovedCount;
			const rejected = vetComments.filter(
				(c) => c.status === "rejected",
			).length;
			const pending = vetComments.filter((c) => c.status === "pending").length;

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
			const files = new Set(vetComments.map((c) => c.comment.path));
			if (files.size > 0) {
				lines.push("");
				lines.push(` ${theme.fg("text", theme.bold("Files:"))}`);
				for (const file of [...files].sort()) {
					const fileComments = vetComments.filter(
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

// ---- File tabs ----

/** Build a file tab with Overview (diff), Comments, and Source views. */
function buildFileTab(
	filePath: string,
	fileComments: VetComment[],
	diffFile: DiffFile | null,
	commentIndices: Map<string, number>,
	tabHandled: Set<string>,
): WorkspaceItem {
	const getIndex = () => commentIndices.get(filePath) ?? 0;
	const setIndex = (i: number) => commentIndices.set(filePath, i);

	return {
		label: shortPath(filePath),
		views: [
			buildOverviewView(filePath, fileComments, diffFile),
			buildCommentsView(filePath, fileComments, getIndex, setIndex, tabHandled),
			buildSourceView(filePath),
		],
		allowHScroll: true,
	};
}

/** Overview view — diff with comment indicators on annotated lines. */
function buildOverviewView(
	filePath: string,
	fileComments: VetComment[],
	diffFile: DiffFile | null,
): WorkspaceView {
	return {
		key: "o",
		label: "Overview",
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

			// Render diff if available
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

/** Comments view — selectable list with approve/reject actions. */
function buildCommentsView(
	filePath: string,
	fileComments: VetComment[],
	getIndex: () => number,
	setIndex: (i: number) => void,
	tabHandled: Set<string>,
): WorkspaceView {
	return {
		key: "c",
		label: "Comments",
		actions: [
			{ key: "a", label: "Approve" },
			{ key: "r", label: "Reject" },
			{ key: "+", label: "New" },
		],
		content: (theme: Theme, width: number) => {
			return renderCommentList(fileComments, getIndex(), theme, width);
		},
		handleInput: (data: string, inputCtx: WorkspaceInputContext) => {
			// Handle 'h' for tab handled
			if (matchesKey(data, "h")) {
				tabHandled.add(filePath);
				inputCtx.invalidate();
				return true;
			}

			if (fileComments.length === 0) {
				if (matchesActionKey(data, "+")) {
					inputCtx.openEditor("New comment for this file:");
					return true;
				}
				return false;
			}

			// ↑↓ navigation
			if (matchesKey(data, Key.up)) {
				setIndex((getIndex() - 1 + fileComments.length) % fileComments.length);
				inputCtx.invalidate();
				inputCtx.scrollToLine(getIndex());
				return true;
			}
			if (matchesKey(data, Key.down)) {
				setIndex((getIndex() + 1) % fileComments.length);
				inputCtx.invalidate();
				inputCtx.scrollToLine(getIndex());
				return true;
			}

			const vc = fileComments[getIndex()];
			if (!vc) return false;

			// Approve
			if (matchesKey(data, "a")) {
				vc.status = "approved";
				checkTabAutoHandled(filePath, fileComments, tabHandled);
				advanceToNextPending(fileComments, getIndex, setIndex);
				inputCtx.invalidate();
				inputCtx.scrollToLine(getIndex());
				return true;
			}

			// Reject
			if (matchesKey(data, "r")) {
				vc.status = "rejected";
				checkTabAutoHandled(filePath, fileComments, tabHandled);
				advanceToNextPending(fileComments, getIndex, setIndex);
				inputCtx.invalidate();
				inputCtx.scrollToLine(getIndex());
				return true;
			}

			// Steer
			if (matchesKey(data, "s")) {
				inputCtx.openEditor(`Steer comment "${vc.comment.body.slice(0, 40)}":`);
				return true;
			}

			// New comment
			if (matchesActionKey(data, "+")) {
				inputCtx.openEditor("New comment for this file:");
				return true;
			}

			return false;
		},
	};
}

/** Source view — full file content, syntax highlighted. */
function buildSourceView(filePath: string): WorkspaceView {
	return {
		key: "s",
		label: "Source",
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

// ---- Comment rendering ----

/** Render a selectable comment list. */
function renderCommentList(
	comments: VetComment[],
	selectedIndex: number,
	theme: Theme,
	width: number,
): string[] {
	const pad = " ".repeat(CONTENT_INDENT);
	const wrapWidth = contentWrapWidth(width);
	const lines: string[] = [];

	if (comments.length === 0) {
		lines.push(`${pad}${theme.fg("dim", "No comments for this file.")}`);
		return lines;
	}

	for (let i = 0; i < comments.length; i++) {
		const vc = comments[i];
		if (!vc) continue;
		const c = vc.comment;
		const isSel = i === selectedIndex;
		const cursor = isSel ? "▸ " : "  ";
		const glyph = COMMENT_GLYPH[vc.status];
		const glyphColor =
			vc.status === "approved"
				? "success"
				: vc.status === "rejected"
					? "error"
					: "accent";

		const lineRange = c.startLine ? `L${c.startLine}-${c.line}` : `L${c.line}`;

		const summary = `${lineRange} — ${c.body.split("\n")[0]}`;
		const line = `${pad}${cursor}${theme.fg(glyphColor, glyph)} ${summary}`;
		lines.push(isSel ? theme.fg("accent", line) : line);

		// Expanded view for selected comment
		if (isSel) {
			lines.push("");
			// Full body
			for (const wl of wordWrap(c.body, wrapWidth - 6)) {
				lines.push(`${pad}      ${theme.fg("text", wl)}`);
			}
			// Rationale
			if (c.rationale) {
				lines.push("");
				lines.push(`${pad}      ${theme.fg("dim", "Rationale:")}`);
				for (const wl of wordWrap(c.rationale, wrapWidth - 6)) {
					lines.push(`${pad}      ${theme.fg("dim", wl)}`);
				}
			}
			const statusColor =
				vc.status === "approved"
					? "success"
					: vc.status === "rejected"
						? "error"
						: "dim";
			lines.push(`${pad}      ${theme.fg(statusColor, `[${vc.status}]`)}`);
			lines.push("");
		}
	}

	return lines;
}

// ---- Helpers ----

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

/** Auto-mark tab as handled when all comments are resolved. */
function checkTabAutoHandled(
	filePath: string,
	comments: VetComment[],
	tabHandled: Set<string>,
): void {
	const allResolved = comments.every((c) => c.status !== "pending");
	if (allResolved) {
		tabHandled.add(filePath);
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

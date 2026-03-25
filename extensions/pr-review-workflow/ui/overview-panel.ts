/**
 * Phase 1: Overview panel: Overview/References/per-file tabs.
 *
 * Uses the workspace prompt for stateful tabbed interaction.
 * References are split into PR Refs (from the PR body and
 * linked issues) and Comment Refs (from PR and issue comments).
 * Each reference is prefixed with a type glyph. Per-file tabs
 * show diff and source views inline.
 */

import * as fs from "node:fs";
import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey } from "@mariozechner/pi-tui";
import type { DiffFile } from "../../lib/github/diff.js";
import {
	languageFromPath,
	renderCode,
	renderDiff,
} from "../../lib/ui/content-renderer.js";
import { workspace } from "../../lib/ui/panel.js";
import {
	CONTENT_INDENT,
	contentWrapWidth,
	wordWrap,
} from "../../lib/ui/text-layout.js";
import type {
	WorkspaceInputContext,
	WorkspaceItem,
	WorkspaceResult,
	WorkspaceView,
} from "../../lib/ui/types.js";
import type { PRContext, Reference } from "../state.js";

/** Result type from the overview panel. */
export type OverviewResult =
	| { action: "review" }
	| { action: "redirect"; note: string }
	| null;

/**
 * Show the Phase 1 overview panel.
 * Returns the user's choice: review, redirect, or null (escape).
 */
export async function showOverviewPanel(
	ctx: ExtensionContext,
	context: PRContext,
	synopsis: string,
	repoPath: string,
): Promise<OverviewResult> {
	let refIndex = 0;

	const items: WorkspaceItem[] = [
		buildOverviewTab(context, synopsis),
		buildReferencesTab(
			ctx,
			context.references,
			() => refIndex,
			(i) => {
				refIndex = i;
			},
		),
		...context.diffFiles.map((file) => buildFileTab(file, repoPath)),
	];

	const result: WorkspaceResult = await workspace(ctx, {
		items,
		tabStatus: () => "pending",
		allComplete: () => true,
		allowHScroll: true,
	});

	if (!result) return null;

	if (result.type === "submit") {
		return { action: "review" };
	}

	if (result.type === "redirect") {
		return { action: "redirect", note: result.note };
	}

	return null;
}

/** Build the Overview tab content. */
function buildOverviewTab(context: PRContext, synopsis: string): WorkspaceItem {
	const overviewView: WorkspaceView = {
		key: "1",
		label: "Overview",
		content: (theme: Theme, width: number) => {
			const pad = " ".repeat(CONTENT_INDENT);
			const wrapWidth = contentWrapWidth(width);
			const lines: string[] = [];

			// PR title
			lines.push(
				` ${theme.fg("accent", theme.bold(`PR #${context.pr.number}: ${context.pr.title}`))}`,
			);
			lines.push(`${pad}${theme.fg("dim", `Author: @${context.pr.author}`)}`);
			lines.push(
				`${pad}${theme.fg("dim", `Branch: ${context.pr.headRefName} → ${context.pr.baseRefName}`)}`,
			);
			lines.push(
				`${pad}${theme.fg("dim", `Files: ${context.pr.changedFiles} changed`)} ${theme.fg("success", `+${context.pr.additions}`)} ${theme.fg("error", `-${context.pr.deletions}`)}`,
			);
			lines.push("");

			// Reviewers
			if (context.reviewers.length > 0) {
				lines.push(` ${theme.fg("text", theme.bold("Reviewers:"))}`);
				for (const r of context.reviewers) {
					const color =
						r.verdict === "APPROVED"
							? "success"
							: r.verdict === "CHANGES_REQUESTED"
								? "error"
								: r.verdict === "COMMENTED"
									? "accent"
									: "dim";
					lines.push(`${pad}@${r.login} ${theme.fg(color, r.verdict)}`);
				}
				lines.push("");
			}

			// Synopsis
			if (synopsis) {
				lines.push(` ${theme.fg("text", theme.bold("Synopsis:"))}`);
				for (const line of wordWrap(synopsis, wrapWidth)) {
					lines.push(`${pad}${theme.fg("text", line)}`);
				}
				lines.push("");
			}

			// Depth limit warning
			if (context.hitDepthLimit) {
				lines.push(
					` ${theme.fg("error", "⚠ Crawl depth limit reached: some references were not followed.")}`,
				);
				lines.push("");
			}

			return lines;
		},
	};

	return { label: "Overview", views: [overviewView] };
}

/** Build the References tab with categorised, glyph-prefixed lists. */
function buildReferencesTab(
	ctx: ExtensionContext,
	references: Reference[],
	getIndex: () => number,
	setIndex: (i: number) => void,
): WorkspaceItem {
	const displayRefs = buildDisplayOrder(references);

	const refView: WorkspaceView = {
		key: "2",
		label: "References",
		enterHint: "open",
		content: (theme: Theme, width: number) => {
			const pad = " ".repeat(CONTENT_INDENT);
			const wrapWidth = contentWrapWidth(width);
			const lines: string[] = [];

			if (displayRefs.length === 0) {
				lines.push(`${pad}${theme.fg("dim", "No references discovered.")}`);
				return lines;
			}

			const prRefs = displayRefs.filter((r) => isPRRef(r));
			const commentRefs = displayRefs.filter((r) => !isPRRef(r));
			const selected = getIndex();
			let flatIdx = 0;

			if (prRefs.length > 0) {
				flatIdx = renderRefSection(
					"PR Refs",
					prRefs,
					flatIdx,
					selected,
					theme,
					pad,
					wrapWidth,
					lines,
				);
			}

			if (commentRefs.length > 0) {
				flatIdx = renderRefSection(
					"Comment Refs",
					commentRefs,
					flatIdx,
					selected,
					theme,
					pad,
					wrapWidth,
					lines,
				);
			}

			return lines;
		},
		handleInput: (data: string, inputCtx: WorkspaceInputContext) => {
			const total = displayRefs.length;
			if (total === 0) return false;

			if (matchesKey(data, Key.up)) {
				setIndex((getIndex() - 1 + total) % total);
				inputCtx.invalidate();
				inputCtx.scrollToContentLine(estimateRefLine(displayRefs, getIndex()));
				return true;
			}
			if (matchesKey(data, Key.down)) {
				setIndex((getIndex() + 1) % total);
				inputCtx.invalidate();
				inputCtx.scrollToContentLine(estimateRefLine(displayRefs, getIndex()));
				return true;
			}

			if (matchesKey(data, Key.enter)) {
				const ref = displayRefs[getIndex()];
				if (ref?.url) {
					openUrl(ctx, ref.url);
				}
				return true;
			}

			return false;
		},
	};

	return { label: "Refs", views: [refView] };
}

/** Build a per-file tab with Diff and Source views. */
function buildFileTab(file: DiffFile, repoPath: string): WorkspaceItem {
	return {
		label: shortPath(file.path),
		views: [buildFileDiffView(file), buildFileSourceView(file, repoPath)],
		allowHScroll: true,
	};
}

/** File Diff view: unified diff without comment overlay. */
function buildFileDiffView(file: DiffFile): WorkspaceView {
	return {
		key: "1",
		label: "Diff",
		content: (theme: Theme, width: number) => {
			const pad = " ".repeat(CONTENT_INDENT);
			const lines: string[] = [];

			lines.push(
				` ${theme.fg("accent", theme.bold(file.path))} ${theme.fg("dim", `(${file.status}, +${file.additions} -${file.deletions})`)}`,
			);
			lines.push("");

			const diffText = buildDiffText(file);
			if (diffText) {
				lines.push(...renderDiff(diffText, theme, width));
			} else {
				lines.push(`${pad}${theme.fg("dim", "(no diff hunks)")}`);
			}

			return lines;
		},
	};
}

/** File Source view: full file content, syntax highlighted. */
function buildFileSourceView(file: DiffFile, repoPath: string): WorkspaceView {
	const filePath = `${repoPath}/${file.path}`;

	return {
		key: "2",
		label: "Source",
		content: (theme: Theme, width: number) => {
			const pad = " ".repeat(CONTENT_INDENT);
			const lines: string[] = [];

			lines.push(` ${theme.fg("accent", theme.bold(file.path))}`);
			lines.push("");

			let source: string;
			try {
				source = fs.readFileSync(filePath, "utf-8");
			} catch {
				return [`${pad}${theme.fg("dim", "(file not available)")}`];
			}

			lines.push(
				...renderCode(source, theme, width, {
					language: languageFromPath(filePath),
				}),
			);

			return lines;
		},
	};
}

/** Build a unified diff string from a DiffFile's hunks. */
function buildDiffText(file: DiffFile): string | null {
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

/** Open a URL in the system browser. */
function openUrl(ctx: ExtensionContext, url: string): void {
	// This is macOS-specific, per plan; it's not cross-platform.
	ctx.ui.notify(`Opening ${url}…`, "info");
	import("node:child_process").then(({ exec }) => {
		exec(`open ${JSON.stringify(url)}`);
	});
}

// -- Reference categorisation and display helpers --

const TYPE_ORDER: Reference["type"][] = [
	"issue",
	"pr",
	"commit",
	"file",
	"external",
];

/** Glyph prefix for each reference type. */
function typeGlyph(type: Reference["type"]): string {
	switch (type) {
		case "issue":
			return "#";
		case "pr":
			return "!";
		case "commit":
			return "○";
		case "file":
			return "●";
		case "external":
			return "→";
	}
}

/**
 * Whether a reference belongs in the "PR Refs" section.
 * PR Refs come from the PR body, linked issues, or
 * depth-0 cross-references. Everything else is a
 * "Comment Ref" (PR comments, issue comments).
 */
function isPRRef(ref: Reference): boolean {
	const s = ref.source;
	return (
		s.startsWith("PR body") ||
		s.startsWith("linked issues") ||
		(ref.depth === 0 && !s.startsWith("PR comment"))
	);
}

/**
 * Build the flat display order: PR Refs then Comment Refs,
 * each sorted by type order then title.
 */
function buildDisplayOrder(refs: Reference[]): Reference[] {
	const sorted = [...refs].sort((a, b) => {
		const typeA = TYPE_ORDER.indexOf(a.type);
		const typeB = TYPE_ORDER.indexOf(b.type);
		if (typeA !== typeB) return typeA - typeB;
		return a.title.localeCompare(b.title);
	});

	const prRefs = sorted.filter((r) => isPRRef(r));
	const commentRefs = sorted.filter((r) => !isPRRef(r));
	return [...prRefs, ...commentRefs];
}

/** Render a section of references into the output lines. */
function renderRefSection(
	heading: string,
	refs: Reference[],
	startIdx: number,
	selected: number,
	theme: Theme,
	pad: string,
	wrapWidth: number,
	lines: string[],
): number {
	lines.push(` ${theme.fg("text", theme.bold(heading))}`);
	let flatIdx = startIdx;

	for (const ref of refs) {
		const isSel = flatIdx === selected;
		const cursor = isSel ? "▸ " : "  ";
		const glyph = typeGlyph(ref.type);
		const depthTag = ref.depth > 0 ? theme.fg("dim", ` ᐩ${ref.depth}`) : "";

		const line = `${pad}${cursor}${glyph} ${ref.title}${depthTag}`;
		lines.push(isSel ? theme.fg("accent", line) : line);

		if (isSel) {
			const desc = refDescription(ref);
			if (desc) {
				for (const wl of wordWrap(desc, wrapWidth - 6)) {
					lines.push(`${pad}      ${theme.fg("dim", wl)}`);
				}
			}
		}

		flatIdx++;
	}

	lines.push("");
	return flatIdx;
}

/**
 * Estimate the display line for a reference at the given flat index.
 * Accounts for section headers, expanded descriptions and blank lines.
 */
function estimateRefLine(refs: Reference[], flatIndex: number): number {
	const prRefs = refs.filter((r) => isPRRef(r));
	const commentRefs = refs.filter((r) => !isPRRef(r));

	let line = 0;
	let idx = 0;

	const sections: Reference[][] = [];
	if (prRefs.length > 0) sections.push(prRefs);
	if (commentRefs.length > 0) sections.push(commentRefs);

	for (const section of sections) {
		line++; // section header
		for (const item of section) {
			if (idx === flatIndex) return line;
			line++;
			if (idx === flatIndex && refDescription(item)) {
				line += 2;
			}
			idx++;
		}
		line++; // blank line after section
	}

	return line;
}

/** Build a description string for a reference's expanded view. */
function refDescription(ref: Reference): string {
	const parts: string[] = [];
	if (ref.description) parts.push(ref.description);
	if (ref.source) parts.push(`from ${ref.source}`);
	return parts.join(" · ");
}

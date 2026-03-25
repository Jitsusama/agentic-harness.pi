/**
 * Phase 1: Overview panel: Overview/References/Source tabs.
 *
 * Uses the workspace prompt for stateful tabbed interaction.
 * References are split into PR Refs (from the PR body and
 * linked issues) and Comment Refs (from PR and issue comments).
 * Each reference is prefixed with a type glyph.
 */

import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey } from "@mariozechner/pi-tui";
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
import type { PRContext, Reference, SourceFile } from "../state.js";

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
): Promise<OverviewResult> {
	// This is mutable selection state for the lists.
	let refIndex = 0;
	let sourceIndex = 0;

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
		buildSourceTab(
			ctx,
			context.sourceFiles,
			() => sourceIndex,
			(i) => {
				sourceIndex = i;
			},
		),
	];

	const result: WorkspaceResult = await workspace(ctx, {
		items,
		tabStatus: () => "pending",
		allComplete: () => true,
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

/** Build the Source tab with a selectable file list. */
function buildSourceTab(
	ctx: ExtensionContext,
	sourceFiles: SourceFile[],
	getIndex: () => number,
	setIndex: (i: number) => void,
): WorkspaceItem {
	const sourceView: WorkspaceView = {
		key: "3",
		label: "Source",
		enterHint: "open",
		content: (theme: Theme, width: number) => {
			const pad = " ".repeat(CONTENT_INDENT);
			const wrapWidth = contentWrapWidth(width);
			const lines: string[] = [];

			if (sourceFiles.length === 0) {
				lines.push(`${pad}${theme.fg("dim", "No source files discovered.")}`);
				return lines;
			}

			const selected = getIndex();

			for (let i = 0; i < sourceFiles.length; i++) {
				const file = sourceFiles[i];
				if (!file) continue;
				const isSel = i === selected;
				const cursor = isSel ? "▸ " : "  ";
				const line = `${pad}${cursor}${file.path}`;
				lines.push(isSel ? theme.fg("accent", line) : line);

				// We show the role description for the selected item.
				if (isSel && file.role) {
					for (const wl of wordWrap(file.role, wrapWidth - 4)) {
						lines.push(`${pad}    ${theme.fg("dim", wl)}`);
					}
				}
			}

			return lines;
		},
		handleInput: (data: string, inputCtx: WorkspaceInputContext) => {
			const total = sourceFiles.length;
			if (total === 0) return false;

			if (matchesKey(data, Key.up)) {
				setIndex((getIndex() - 1 + total) % total);
				inputCtx.invalidate();
				inputCtx.scrollToContentLine(getIndex());
				return true;
			}
			if (matchesKey(data, Key.down)) {
				setIndex((getIndex() + 1) % total);
				inputCtx.invalidate();
				inputCtx.scrollToContentLine(getIndex());
				return true;
			}

			if (matchesKey(data, Key.enter)) {
				const file = sourceFiles[getIndex()];
				if (file?.url) {
					openUrl(ctx, file.url);
				}
				return true;
			}

			return false;
		},
	};

	return { label: "Source", views: [sourceView] };
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

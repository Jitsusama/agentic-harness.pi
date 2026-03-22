/**
 * Phase 1: Overview panel: Overview/References/Source tabs.
 *
 * Uses the workspace prompt for stateful tabbed interaction.
 * References and Source tabs have selectable lists with ↑↓
 * navigation and Enter to open URLs in the system browser.
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
		globalActions: [{ key: "r", label: "Review" }],
		tabStatus: () => "pending",
		allComplete: () => false,
	});

	if (!result) return null;

	if (result.type === "action" && result.key === "r") {
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

/** Build the References tab with a selectable list. */
function buildReferencesTab(
	ctx: ExtensionContext,
	references: Reference[],
	getIndex: () => number,
	setIndex: (i: number) => void,
): WorkspaceItem {
	const refView: WorkspaceView = {
		key: "2",
		label: "References",
		content: (theme: Theme, width: number) => {
			const pad = " ".repeat(CONTENT_INDENT);
			const wrapWidth = contentWrapWidth(width);
			const lines: string[] = [];

			if (references.length === 0) {
				lines.push(`${pad}${theme.fg("dim", "No references discovered.")}`);
				return lines;
			}

			const selected = getIndex();

			// We group references by type.
			const groups = groupByType(references);
			let flatIdx = 0;

			for (const [type, refs] of groups) {
				lines.push(` ${theme.fg("text", theme.bold(typeLabel(type)))}`);
				for (const ref of refs) {
					const isSel = flatIdx === selected;
					const cursor = isSel ? "▸ " : "  ";
					const depthTag =
						ref.depth > 0 ? theme.fg("dim", ` ᐩ${ref.depth}`) : "";

					const line = `${pad}${cursor}${ref.title}${depthTag}`;
					lines.push(isSel ? theme.fg("accent", line) : line);

					// We show the description below the selected item.
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
			}

			return lines;
		},
		handleInput: (data: string, inputCtx: WorkspaceInputContext) => {
			const total = references.length;
			if (total === 0) return false;

			// ↑↓ navigation
			if (matchesKey(data, Key.up)) {
				setIndex((getIndex() - 1 + total) % total);
				inputCtx.invalidate();
				inputCtx.scrollToLine(estimateRefLine(references, getIndex()));
				return true;
			}
			if (matchesKey(data, Key.down)) {
				setIndex((getIndex() + 1) % total);
				inputCtx.invalidate();
				inputCtx.scrollToLine(estimateRefLine(references, getIndex()));
				return true;
			}

			// Enter opens URL
			if (matchesKey(data, Key.enter)) {
				const flat = flattenByType(references);
				const ref = flat[getIndex()];
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
				inputCtx.scrollToLine(getIndex());
				return true;
			}
			if (matchesKey(data, Key.down)) {
				setIndex((getIndex() + 1) % total);
				inputCtx.invalidate();
				inputCtx.scrollToLine(getIndex());
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

/** Group references by type, preserving order. */
function groupByType(refs: Reference[]): [Reference["type"], Reference[]][] {
	const order: Reference["type"][] = [
		"issue",
		"pr",
		"commit",
		"file",
		"external",
	];
	const groups = new Map<Reference["type"], Reference[]>();

	for (const ref of refs) {
		if (!groups.has(ref.type)) groups.set(ref.type, []);
		groups.get(ref.type)?.push(ref);
	}

	return order
		.filter((t) => groups.has(t))
		.map((t) => [t, groups.get(t) ?? []]);
}

/** Flatten references in display order (grouped by type). */
function flattenByType(refs: Reference[]): Reference[] {
	return groupByType(refs).flatMap(([_, items]) => items);
}

/**
 * Estimate the display line for a reference at the given flat index.
 * Accounts for group headers, expanded descriptions, and blank lines.
 */
function estimateRefLine(refs: Reference[], flatIndex: number): number {
	const groups = groupByType(refs);
	let line = 0;
	let idx = 0;

	for (const [_, items] of groups) {
		line++; // group header
		for (const item of items) {
			if (idx === flatIndex) return line;
			line++; // item line
			// The selected item expands with a description (~2 lines estimate).
			if (idx === flatIndex && refDescription(item)) {
				line += 2;
			}
			idx++;
		}
		line++; // blank line after group
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

/** Human-readable label for a reference type. */
function typeLabel(type: Reference["type"]): string {
	switch (type) {
		case "issue":
			return "Issues";
		case "pr":
			return "Pull Requests";
		case "commit":
			return "Commits";
		case "file":
			return "Files";
		case "external":
			return "External Links";
	}
}

/**
 * Panel rendering — pure functions for drawing panel content,
 * options, editor, scrollbar, and tab bar.
 *
 * All functions take state + theme + dimensions and return
 * lines or strings. No side effects or mutation.
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import {
	type Editor,
	type EditorTheme,
	truncateToWidth,
	visibleWidth,
} from "@mariozechner/pi-tui";
import type { PanelOption, PanelPage, SeriesSelection } from "./panel.js";

/** Build a pi-tui Editor theme from a pi Theme. */
export function buildEditorTheme(theme: Theme): EditorTheme {
	return {
		borderColor: (s) => theme.fg("accent", s),
		selectList: {
			selectedPrefix: (t) => theme.fg("accent", t),
			selectedText: (t) => theme.fg("accent", t),
			description: (t) => theme.fg("muted", t),
			scrollInfo: (t) => theme.fg("dim", t),
			noMatch: (t) => theme.fg("warning", t),
		},
	};
}

/** Render the numbered option list with selection indicator. */
export function renderOptionsList(
	options: PanelOption[],
	selected: number,
	theme: Theme,
): string[] {
	const lines: string[] = [];
	for (let i = 0; i < options.length; i++) {
		const opt = options[i];
		if (!opt) continue;
		const active = i === selected;
		const prefix = active ? theme.fg("accent", "> ") : "  ";
		const color = active ? "accent" : "text";
		lines.push(prefix + theme.fg(color, `${i + 1}. ${opt.label}`));
		if (opt.description) {
			lines.push(`     ${theme.fg("muted", opt.description)}`);
		}
	}
	return lines;
}

/** Render the inline editor with submit/cancel hints. */
export function renderInlineEditor(
	editor: Editor,
	width: number,
	theme: Theme,
): string[] {
	const lines: string[] = [""];
	for (const line of editor.render(width - 4)) {
		lines.push(` ┃ ${line}`);
	}
	lines.push("");
	lines.push(theme.fg("dim", " Enter submit · Esc back"));
	return lines;
}

/**
 * Build a scrollbar column for the viewport. Returns one
 * character per visible line: █ for the thumb, ░ for the track.
 */
export function buildScrollbar(
	totalLines: number,
	viewportSize: number,
	offset: number,
	theme: Theme,
): string[] {
	const thumbSize = Math.max(
		1,
		Math.round((viewportSize / totalLines) * viewportSize),
	);
	const maxOffset = totalLines - viewportSize;
	const scrollFraction = maxOffset > 0 ? offset / maxOffset : 0;
	const thumbStart = Math.round(scrollFraction * (viewportSize - thumbSize));

	const bar: string[] = [];
	for (let i = 0; i < viewportSize; i++) {
		const isThumb = i >= thumbStart && i < thumbStart + thumbSize;
		bar.push(isThumb ? theme.fg("accent", "█") : theme.fg("dim", "░"));
	}
	return bar;
}

/**
 * ANSI-aware horizontal slice. Skips `offset` visible characters
 * from the start, then takes up to `width` visible characters.
 * Preserves ANSI escape sequences that are active at the slice
 * boundary.
 */
export function horizontalSlice(
	text: string,
	offset: number,
	width: number,
): string {
	if (offset === 0) return truncateToWidth(text, width);

	let visCount = 0;
	let i = 0;
	let activeEscapes = "";

	// Skip `offset` visible characters, collecting ANSI state
	while (i < text.length && visCount < offset) {
		if (text[i] === "\x1b" && text[i + 1] === "[") {
			const escStart = i;
			i += 2;
			while (i < text.length && !/[A-Za-z]/.test(text[i] ?? "")) i++;
			i++;
			const esc = text.slice(escStart, i);
			if (esc === "\x1b[0m" || esc === "\x1b[m") {
				activeEscapes = "";
			} else {
				activeEscapes += esc;
			}
		} else {
			visCount++;
			i++;
		}
	}

	const remainder = activeEscapes + text.slice(i);
	return truncateToWidth(remainder, width);
}

/** Find the maximum visible width across content lines. */
export function maxContentWidth(lines: string[]): number {
	let max = 0;
	for (const line of lines) {
		const w = visibleWidth(line);
		if (w > max) max = w;
	}
	return max;
}

/** Render scrollable content with optional scrollbar. */
export function renderScrollableContent(
	contentLines: string[],
	scrollOffset: number,
	hScrollOffset: number,
	budget: number,
	width: number,
	theme: Theme,
): { lines: string[]; needsVScroll: boolean; needsHScroll: boolean } {
	const needsVScroll = contentLines.length > budget;
	const needsHScroll = maxContentWidth(contentLines) > width;
	const lines: string[] = [];

	if (needsVScroll) {
		const visible = contentLines.slice(scrollOffset, scrollOffset + budget);
		const scrollbar = buildScrollbar(
			contentLines.length,
			budget,
			scrollOffset,
			theme,
		);
		const contentWidth = width - 2;
		for (let i = 0; i < visible.length; i++) {
			const sliced = truncateToWidth(
				horizontalSlice(visible[i] ?? "", hScrollOffset, contentWidth),
				contentWidth,
			);
			// CSI absolute column positioning for the scrollbar
			const scrollCol = width;
			lines.push(`${sliced}\x1b[${scrollCol}G${scrollbar[i] ?? ""}`);
		}
	} else {
		for (const line of contentLines) {
			lines.push(
				truncateToWidth(horizontalSlice(line, hScrollOffset, width), width),
			);
		}
	}

	return { lines, needsVScroll, needsHScroll };
}

function selectedIcon(
	page: PanelPage,
	selection: SeriesSelection | undefined,
): string {
	if (!selection) return "□";
	const opt = page.options.find((o) => o.value === selection.value);
	return opt?.icon ?? "✓";
}

/** Render the tab bar for multi-page panels. */
export function renderTabBar(
	pages: PanelPage[],
	currentTab: number,
	selections: Map<number, SeriesSelection>,
	theme: Theme,
): string {
	const tabs: string[] = [];
	for (let i = 0; i < pages.length; i++) {
		const isActive = i === currentTab;
		const selection = selections.get(i);
		const isAnswered = !!selection;
		const page = pages[i];
		if (!page) continue;
		const lbl = page.label;
		const icon = selectedIcon(page, selection);
		const color = isAnswered ? "success" : "muted";
		const text = ` ${icon} ${lbl} `;
		const styled = isActive
			? theme.bg("selectedBg", theme.fg("text", text))
			: theme.fg(color, text);
		tabs.push(`${styled} `);
	}
	return ` ${tabs.join("")}`;
}

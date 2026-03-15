/**
 * ScrollRegion — content viewport with vertical and horizontal
 * scrolling, scrollbar rendering, and height budget management.
 *
 * Manages a viewport into content that may exceed the available
 * height. Shows a scrollbar column when content overflows.
 * Handles Shift+↑↓ for vertical scroll and Shift+←→ for
 * horizontal scroll (code content).
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import {
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@mariozechner/pi-tui";
import {
	CONTENT_INDENT,
	GLYPH,
	H_SCROLL_STEP,
	MAX_CONTENT_WIDTH,
	MAX_HEIGHT_FRACTION,
	PI_CHROME_LINES,
	SCROLLBAR_GUTTER,
} from "./types.js";

// ---- Types ----

export interface ScrollState {
	/** Vertical scroll offset (lines from top). */
	vOffset: number;
	/** Horizontal scroll offset (visible characters from left). */
	hOffset: number;
}

// ---- ScrollRegion Component ----

/** Render the content viewport with optional scrollbar. */
export function renderScrollRegion(
	contentLines: string[],
	state: ScrollState,
	budget: number,
	width: number,
	theme: Theme,
	needsHScroll = false,
): { lines: string[]; needsVScroll: boolean; needsHScroll: boolean } {
	const needsVScroll = contentLines.length > budget;
	const lines: string[] = [];

	const vOffset = clampVScroll(state.vOffset, contentLines.length, budget);

	if (needsVScroll) {
		const visible = contentLines.slice(vOffset, vOffset + budget);
		const scrollbar = buildScrollbar(
			contentLines.length,
			budget,
			vOffset,
			theme,
		);
		const contentWidth = width - SCROLLBAR_GUTTER;
		for (let i = 0; i < visible.length; i++) {
			const sliced = horizontalSlice(
				visible[i] ?? "",
				state.hOffset,
				contentWidth,
			);
			const truncated = truncateToWidth(sliced, contentWidth);
			// CSI absolute column positioning for the scrollbar
			const scrollCol = width;
			lines.push(`${truncated}\x1b[${scrollCol}G${scrollbar[i] ?? ""}`);
		}
	} else {
		for (const line of contentLines) {
			lines.push(
				truncateToWidth(horizontalSlice(line, state.hOffset, width), width),
			);
		}
	}

	return { lines, needsVScroll, needsHScroll };
}

/** Handle scroll-related key input. Returns updated state or null if unhandled. */
export function handleScrollInput(
	data: string,
	state: ScrollState,
	budget: number,
	contentLength: number,
): ScrollState | null {
	if (matchesKey(data, "pageup") || matchesKey(data, Key.shift("up"))) {
		return { ...state, vOffset: Math.max(0, state.vOffset - budget) };
	}
	if (matchesKey(data, "pagedown") || matchesKey(data, Key.shift("down"))) {
		return {
			...state,
			vOffset: clampVScroll(state.vOffset + budget, contentLength, budget),
		};
	}
	if (matchesKey(data, Key.shift("left"))) {
		return {
			...state,
			hOffset: Math.max(0, state.hOffset - H_SCROLL_STEP),
		};
	}
	if (matchesKey(data, Key.shift("right"))) {
		return { ...state, hOffset: state.hOffset + H_SCROLL_STEP };
	}
	return null;
}

/** Clamp a vertical scroll offset to valid bounds. */
export function clampVScroll(
	offset: number,
	contentLength: number,
	budget: number,
): number {
	const maxScroll = Math.max(0, contentLength - budget);
	return Math.max(0, Math.min(offset, maxScroll));
}

/** Compute the content area height budget. */
export function contentBudget(chromeLines: number): number {
	const termRows = process.stdout.rows || 40;
	const maxHeight = Math.floor(termRows * MAX_HEIGHT_FRACTION);
	return Math.max(3, maxHeight - PI_CHROME_LINES - chromeLines);
}

/**
 * Compute the content width — capped at MAX_CONTENT_WIDTH for
 * readability, with CONTENT_INDENT per side.
 */
export function contentWidth(termWidth: number): number {
	return Math.min(termWidth - CONTENT_INDENT * 2, MAX_CONTENT_WIDTH);
}

// ---- Internal helpers ----

/** Find the maximum visible width across content lines. */
/** Compute the maximum visible width across all lines. */
export function maxContentWidth(lines: string[]): number {
	let max = 0;
	for (const line of lines) {
		const w = visibleWidth(line);
		if (w > max) max = w;
	}
	return max;
}

/**
 * Build a scrollbar column. Returns one character per visible
 * line: █ for the thumb, ░ for the track.
 */
function buildScrollbar(
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
		bar.push(
			isThumb
				? theme.fg("accent", GLYPH.scrollThumb)
				: theme.fg("dim", GLYPH.scrollEmpty),
		);
	}
	return bar;
}

/**
 * ANSI-aware horizontal slice. Skips `offset` visible characters
 * from the start, then takes up to `width` visible characters.
 * Preserves ANSI escape sequences that are active at the slice
 * boundary.
 */
function horizontalSlice(text: string, offset: number, width: number): string {
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

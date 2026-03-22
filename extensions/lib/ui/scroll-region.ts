/**
 * ScrollRegion: content viewport with vertical and horizontal
 * scrolling, scrollbar rendering and height budget management.
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
import { getPanelHeightFraction } from "./panel-height.js";
import { GLYPH } from "./types.js";

/** Maximum content width in columns (readability cap). */
export const MAX_CONTENT_WIDTH = 100;

/**
 * Width passed to content functions when horizontal scrolling
 * is enabled. Large enough that content renderers won't truncate,
 * letting the scroll region handle the horizontal viewport.
 */
export const HSCROLL_CONTENT_WIDTH = 10_000;

/** Horizontal scroll step in visible characters. */
export const H_SCROLL_STEP = 20;

/** Lines scrolled per Shift+↑↓ fine scroll step. */
export const FINE_SCROLL_LINES = 3;

/**
 * Fraction of the viewport kept visible when coarse-scrolling
 * (PageUp/Down). 0.5 means half the viewport stays from the
 * previous view, so the reader never loses context.
 */
export const COARSE_SCROLL_OVERLAP_FRACTION = 0.5;

/** Width reserved for the vertical scrollbar gutter. */
export const SCROLLBAR_GUTTER = 2;

/** Tracks the current scroll position within a content region. */
export interface ScrollState {
	/** Vertical scroll offset (lines from top). */
	vOffset: number;
	/** Horizontal scroll offset (visible characters from left). */
	hOffset: number;
}

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
			// We use CSI absolute column positioning for the scrollbar.
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
	needsHScroll = false,
	maxHOffset = Number.MAX_SAFE_INTEGER,
): ScrollState | null {
	// Fine scroll: Shift+↑↓ moves a few lines at a time.
	if (matchesKey(data, Key.shift("up"))) {
		return {
			...state,
			vOffset: Math.max(0, state.vOffset - FINE_SCROLL_LINES),
		};
	}
	if (matchesKey(data, Key.shift("down"))) {
		return {
			...state,
			vOffset: clampVScroll(
				state.vOffset + FINE_SCROLL_LINES,
				contentLength,
				budget,
			),
		};
	}

	// Coarse scroll: PageUp/Down (Fn+↑↓ on Mac) moves half a page.
	const coarseStep = Math.max(
		1,
		Math.floor(budget * (1 - COARSE_SCROLL_OVERLAP_FRACTION)),
	);
	if (matchesKey(data, "pageup")) {
		return { ...state, vOffset: Math.max(0, state.vOffset - coarseStep) };
	}
	if (matchesKey(data, "pagedown")) {
		return {
			...state,
			vOffset: clampVScroll(state.vOffset + coarseStep, contentLength, budget),
		};
	}

	// Horizontal scroll: Shift+←→.
	if (needsHScroll && matchesKey(data, Key.shift("left"))) {
		return {
			...state,
			hOffset: Math.max(0, state.hOffset - H_SCROLL_STEP),
		};
	}
	if (needsHScroll && matchesKey(data, Key.shift("right"))) {
		return {
			...state,
			hOffset: Math.min(state.hOffset + H_SCROLL_STEP, maxHOffset),
		};
	}
	return null;
}

/** Clamp a vertical scroll offset to valid bounds. */
function clampVScroll(
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
	const maxHeight = Math.floor(termRows * getPanelHeightFraction());
	return Math.max(3, maxHeight - chromeLines);
}

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

	// We skip `offset` visible characters, collecting ANSI state along the way.
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

/**
 * TabStrip — scrolling tab bar with status glyphs, progress bar,
 * and Ctrl+number jump.
 *
 * Renders:  ◆ R1  ✕ R2  ◇ R3  …  ◇ R7     [▓▓░░░] 2/7
 *
 * Features:
 *   - First and last tabs always visible
 *   - … (ellipsis) for hidden tabs between visible ones
 *   - Current tab label is underlined
 *   - Status glyph left of each label (◆ ◇ ✕ ◈)
 *   - Progress bar [▓▓░░░] N/M right-aligned
 *   - Ctrl+number jumps to tab N directly
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import {
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@mariozechner/pi-tui";
import { GLYPH, type TabStatus } from "./types.js";

// ---- Constants ----

/** Width of ellipsis segment including spacing. */
const ELLIPSIS_WIDTH = 3;

/** Width of a single progress bar character. */
const PROGRESS_BAR_WIDTH = 5;

// ---- Rendering ----

/** Map a tab status to its glyph and theme color. */
function statusGlyph(status: TabStatus, theme: Theme): string {
	switch (status) {
		case "complete":
			return theme.fg("success", GLYPH.complete);
		case "rejected":
			return theme.fg("error", GLYPH.rejected);
		case "active":
			return theme.fg("accent", GLYPH.active);
		default:
			return theme.fg("dim", GLYPH.pending);
	}
}

/** Render a single tab segment (glyph + label). */
function renderTab(
	label: string,
	status: TabStatus,
	isCurrent: boolean,
	theme: Theme,
): string {
	const glyph = statusGlyph(status, theme);
	const text = isCurrent ? theme.underline(label) : label;
	return `${glyph} ${text}`;
}

/** Build the progress bar: [▓▓░░░] N/M */
function renderProgress(
	completed: number,
	total: number,
	theme: Theme,
): string {
	const filled = Math.min(completed, PROGRESS_BAR_WIDTH);
	const empty = PROGRESS_BAR_WIDTH - filled;
	const bar =
		theme.fg("accent", GLYPH.scrollFilled.repeat(filled)) +
		theme.fg("dim", GLYPH.scrollEmpty.repeat(empty));
	return `[${bar}] ${completed}/${total}`;
}

/**
 * Render the tab strip line.
 *
 * Handles tab overflow by showing first tab, last tab, and
 * as many around the current tab as fit, with … for gaps.
 */
export function renderTabStrip(
	labels: string[],
	statuses: TabStatus[],
	currentIndex: number,
	width: number,
	theme: Theme,
): string {
	const total = labels.length;
	const completed = statuses.filter(
		(s) => s === "complete" || s === "rejected",
	).length;
	const progress = renderProgress(completed, total, theme);
	const progressWidth = visibleWidth(progress);

	// Available width for tabs (minus indent, progress, and spacing)
	const indent = 2;
	const spacing = 4; // gap between tabs and progress
	const availableWidth = width - indent - progressWidth - spacing;

	// Build all tab segments
	const segments = labels.map((label, i) =>
		renderTab(label, statuses[i] ?? "pending", i === currentIndex, theme),
	);
	const segmentWidths = segments.map(
		(s) => visibleWidth(s) + 2, // +2 for inter-tab spacing
	);

	// Try to fit all tabs
	const totalTabWidth = segmentWidths.reduce((a, b) => a + b, 0);
	if (totalTabWidth <= availableWidth) {
		const tabLine = segments.join("  ");
		const tabWidth = visibleWidth(tabLine);
		const gap = " ".repeat(
			Math.max(2, width - indent - tabWidth - progressWidth),
		);
		return truncateToWidth(`${"  "}${tabLine}${gap}${progress}`, width);
	}

	// Overflow — show first, current neighborhood, and last with ellipsis
	const visible = selectVisibleTabs(
		segmentWidths,
		currentIndex,
		availableWidth,
	);
	const parts: string[] = [];
	let lastShown = -1;

	for (const idx of visible) {
		if (lastShown >= 0 && idx > lastShown + 1) {
			parts.push(theme.fg("dim", GLYPH.ellipsis));
		}
		parts.push(segments[idx] ?? "");
		lastShown = idx;
	}

	const tabLine = parts.join("  ");
	const tabWidth = visibleWidth(tabLine);
	const gap = " ".repeat(
		Math.max(2, width - indent - tabWidth - progressWidth),
	);
	return truncateToWidth(`${"  "}${tabLine}${gap}${progress}`, width);
}

/**
 * Select which tab indices to show when they don't all fit.
 * Always includes first and last. Fills from current outward.
 */
function selectVisibleTabs(
	widths: number[],
	currentIndex: number,
	available: number,
): number[] {
	const total = widths.length;
	if (total <= 2) return Array.from({ length: total }, (_, i) => i);

	// Reserve space for first, last, and ellipsis
	const firstW = widths[0] ?? 0;
	const lastW = widths[total - 1] ?? 0;
	let used = firstW + lastW + ELLIPSIS_WIDTH * 2;

	const result = new Set<number>([0, total - 1]);

	// Add current tab
	const currentW = widths[currentIndex] ?? 0;
	if (!result.has(currentIndex) && used + currentW <= available) {
		result.add(currentIndex);
		used += currentW;
	}

	// Expand outward from current
	let lo = currentIndex - 1;
	let hi = currentIndex + 1;
	while (lo > 0 || hi < total - 1) {
		if (lo > 0 && !result.has(lo)) {
			const w = widths[lo] ?? 0;
			if (used + w <= available) {
				result.add(lo);
				used += w;
			}
			lo--;
		}
		if (hi < total - 1 && !result.has(hi)) {
			const w = widths[hi] ?? 0;
			if (used + w <= available) {
				result.add(hi);
				used += w;
			}
			hi++;
		}
		if (
			(lo <= 0 || (widths[lo] ?? 0) + used > available) &&
			(hi >= total - 1 || (widths[hi] ?? 0) + used > available)
		) {
			break;
		}
	}

	return [...result].sort((a, b) => a - b);
}

/** Handle tab navigation key input. Returns new index or null. */
export function handleTabInput(
	data: string,
	currentIndex: number,
	tabCount: number,
): number | null {
	// Tab / → = next
	if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
		return (currentIndex + 1) % tabCount;
	}
	// Shift+Tab / ← = prev
	if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
		return (currentIndex - 1 + tabCount) % tabCount;
	}
	// Ctrl+number jumps to tab N (Ctrl+1 = tab 0, etc.)
	for (let n = 1; n <= Math.min(tabCount, 9); n++) {
		if (matchesKey(data, Key.ctrl(String(n)))) {
			return n - 1;
		}
	}
	return null;
}

/**
 * NavigableList: shared rendering and navigation for cursor-
 * driven vertical lists.
 *
 * Two flavours:
 *   - Flat: a single list of items
 *   - Sectioned: items grouped under headings
 *
 * Each item has a one-line summary, an optional leading glyph,
 * optional detail lines (shown only when selected) and optional
 * subtitle lines (shown for every item).
 *
 * The renderer owns cursor display, accent highlighting and
 * expand/collapse. Domain code owns the data mapping (what
 * glyphs look like, how summaries are built, what detail
 * contains).
 *
 * Rendering example (flat):
 *
 *     ○ L12-15 suggestion: extract helper
 *   ▸ ● L30 issue: missing null check
 *       Body of the comment explaining the issue
 *       in detail, word-wrapped to fit.
 *       [pending]
 *     ◆ L45 nitpick: rename variable
 *
 * Rendering example (sectioned):
 *
 *   PR Refs
 *     # Fix login redirect loop
 *   ▸ ! Refactor auth middleware
 *       from PR body · external
 *
 *   Comment Refs
 *     → MDN docs on CORS
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey } from "@mariozechner/pi-tui";
import { CONTENT_INDENT, GLYPH } from "./types.js";

// -- Types --

/** A single item in a navigable list. */
export interface NavigableItem {
	/** Coloured glyph before the summary (e.g., status indicator). */
	glyph?: string;
	/** One-line summary text. Domain builds this string. */
	summary: string;
	/** Lines shown under every item regardless of selection (dim). */
	subtitle?: string[];
	/** Lines shown only when this item is selected (expanded detail). */
	detail?: string[];
}

/** A group of items under a heading. */
export interface NavigableSection {
	/** Section heading text. */
	heading: string;
	/** Items within this section. */
	items: NavigableItem[];
}

/** Options for rendering a navigable list. */
export interface NavigableListOptions {
	/** Show "N. " number prefix before each item. */
	numbered?: boolean;
	/** Message shown when the list is empty. */
	emptyMessage?: string;
}

/** Output from rendering a navigable list. */
export interface NavigableListOutput {
	/** Rendered lines ready for the panel. */
	lines: string[];
	/** Line index of the selected item (for scrollToContentLine). */
	selectedLine: number;
}

// -- Rendering --

const PAD = " ".repeat(CONTENT_INDENT);
/** Extra indent for detail and subtitle lines (past cursor + glyph). */
const DETAIL_INDENT = `${PAD}      `;

/**
 * Render a flat list of items with cursor and expand/collapse.
 * Returns rendered lines and the line index of the selected item.
 */
export function renderNavigableList(
	items: NavigableItem[],
	selectedIndex: number,
	theme: Theme,
	options?: NavigableListOptions,
): NavigableListOutput {
	const lines: string[] = [];
	let selectedLine = 0;

	if (items.length === 0) {
		const msg = options?.emptyMessage ?? "No items.";
		lines.push(`${PAD}${theme.fg("dim", msg)}`);
		return { lines, selectedLine: 0 };
	}

	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		if (!item) continue;

		const isSel = i === selectedIndex;
		if (isSel) selectedLine = lines.length;

		const numberPrefix = options?.numbered ? `${i + 1}. ` : "";
		renderItem(item, isSel, numberPrefix, theme, lines);
	}

	return { lines, selectedLine };
}

/**
 * Render a sectioned list. Items are grouped under headings
 * with a flat selection index spanning all sections.
 */
export function renderNavigableSections(
	sections: NavigableSection[],
	selectedIndex: number,
	theme: Theme,
	options?: NavigableListOptions,
): NavigableListOutput {
	const lines: string[] = [];
	let selectedLine = 0;
	let flatIndex = 0;

	const totalItems = sections.reduce((n, s) => n + s.items.length, 0);
	if (totalItems === 0) {
		const msg = options?.emptyMessage ?? "No items.";
		lines.push(`${PAD}${theme.fg("dim", msg)}`);
		return { lines, selectedLine: 0 };
	}

	for (const section of sections) {
		lines.push(` ${theme.fg("text", theme.bold(section.heading))}`);

		for (const item of section.items) {
			const isSel = flatIndex === selectedIndex;
			if (isSel) selectedLine = lines.length;

			const numberPrefix = options?.numbered ? `${flatIndex + 1}. ` : "";
			renderItem(item, isSel, numberPrefix, theme, lines);
			flatIndex++;
		}

		lines.push("");
	}

	return { lines, selectedLine };
}

/** Render a single item: cursor, glyph, summary, subtitle, detail. */
function renderItem(
	item: NavigableItem,
	isSelected: boolean,
	numberPrefix: string,
	theme: Theme,
	lines: string[],
): void {
	const cursor = isSelected ? `${GLYPH.cursor} ` : "  ";
	const glyph = item.glyph ? `${item.glyph} ` : "";
	const line = `${PAD}${cursor}${glyph}${numberPrefix}${item.summary}`;
	lines.push(isSelected ? theme.fg("accent", line) : line);

	// Subtitle lines are shown for every item (dim).
	if (item.subtitle) {
		for (const sub of item.subtitle) {
			const subLine = `${DETAIL_INDENT}${sub}`;
			lines.push(
				isSelected
					? theme.fg("accent", theme.fg("dim", subLine))
					: theme.fg("dim", subLine),
			);
		}
	}

	// Detail lines are shown only for the selected item.
	if (isSelected && item.detail) {
		for (const det of item.detail) {
			lines.push(det);
		}
	}
}

// -- Navigation --

/**
 * Handle ↑/↓ navigation. Returns the new index or null if
 * the key was not a navigation key. Wraps around at boundaries.
 */
export function handleNavigableListInput(
	data: string,
	selectedIndex: number,
	itemCount: number,
): number | null {
	if (itemCount === 0) return null;

	if (matchesKey(data, Key.up)) {
		return (selectedIndex - 1 + itemCount) % itemCount;
	}
	if (matchesKey(data, Key.down)) {
		return (selectedIndex + 1) % itemCount;
	}

	return null;
}

/**
 * Count the total number of items across sections.
 * Useful for passing to handleNavigableListInput.
 */
export function sectionItemCount(sections: NavigableSection[]): number {
	return sections.reduce((n, s) => n + s.items.length, 0);
}

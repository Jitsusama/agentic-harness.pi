/**
 * Word wrapping and text formatting helpers used by the panel
 * and content rendering systems.
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import { CONTENT_INDENT } from "./types.js";

export { CONTENT_INDENT };

/** Fallback content width when the panel width is unavailable. */
const FALLBACK_CONTENT_WIDTH = 72;

/**
 * Compute the word-wrap width for panel content. Caps to the
 * visible terminal width so text stays stable during horizontal
 * scrolling (the framework passes a wider value to allow
 * pre-formatted content to extend beyond the viewport).
 */
export function contentWrapWidth(renderWidth: number): number {
	const cols = process.stdout.columns;
	const visible =
		cols && cols > 0 ? cols - CONTENT_INDENT * 2 : FALLBACK_CONTENT_WIDTH;
	const fromRender =
		renderWidth > 0 ? renderWidth - CONTENT_INDENT * 2 : FALLBACK_CONTENT_WIDTH;
	return Math.min(fromRender, visible);
}

/**
 * Word-wrap text to maxWidth, preserving paragraph breaks.
 * Splits on newlines first, then wraps each paragraph
 * independently at word boundaries.
 *
 * Measured in the columns a terminal draws, not in JavaScript string
 * length. The two agree for plain text and, by luck, for emoji, which are
 * two UTF-16 units and two columns. They disagree for anything East Asian,
 * one unit and two columns, so counting length wrapped such a line to twice
 * the width it was given. Downstream that is not a visible wrapping fault:
 * the panel truncates what overruns, so the end of the line simply goes.
 */
export function wordWrap(text: string, maxWidth: number): string[] {
	// A returned line is one terminal row, so an embedded newline is a
	// hard break on every path. The fast path once measured the whole
	// string and returned a short multi-line body untouched, and the
	// newlines inside it moved the terminal's cursor mid-frame: rows
	// spliced with stale content, exactly one frame-shear per newline.
	if (maxWidth <= 0) return text.split("\n");
	if (!text.includes("\n") && visibleWidth(text) <= maxWidth) return [text];
	const lines: string[] = [];
	for (const paragraph of text.split("\n")) {
		if (visibleWidth(paragraph) <= maxWidth) {
			lines.push(paragraph);
			continue;
		}
		let remaining = paragraph;
		while (visibleWidth(remaining) > maxWidth) {
			const breakAt = breakIndex(remaining, maxWidth);
			lines.push(remaining.slice(0, breakAt));
			remaining = remaining.slice(breakAt).trimStart();
		}
		if (remaining) lines.push(remaining);
	}
	return lines;
}

/**
 * Where to cut a line so its head fits, preferring the last space that fits.
 *
 * Returns a string index rather than a column, since that is what slicing
 * wants and one is not the other once a character is wider than one column.
 * Never returns zero: a first character too wide for the whole width would
 * otherwise wrap forever, so it is emitted on a line of its own and overruns
 * by design, there being nowhere narrower to put it.
 */
function breakIndex(text: string, maxWidth: number): number {
	let width = 0;
	let index = 0;
	let lastSpace = -1;
	let firstCharacter = 0;

	for (const character of text) {
		if (firstCharacter === 0) firstCharacter = character.length;
		const next = width + visibleWidth(character);
		if (next > maxWidth) break;
		if (character === " ") lastSpace = index;
		index += character.length;
		width = next;
	}

	if (lastSpace > 0) return lastSpace;
	return index > 0 ? index : firstCharacter;
}

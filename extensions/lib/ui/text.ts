/**
 * Text utilities — word wrapping and text formatting helpers
 * for panel and content rendering.
 */

/** Content indent used by panel content renderers (spaces per side). */
export const CONTENT_INDENT = 2;

/** Fallback content width when the panel width is unavailable. */
export const FALLBACK_CONTENT_WIDTH = 72;

/**
 * Word-wrap text to maxWidth, preserving paragraph breaks.
 * Splits on newlines first, then wraps each paragraph
 * independently at word boundaries.
 */
export function wordWrap(text: string, maxWidth: number): string[] {
	if (maxWidth <= 0 || text.length <= maxWidth) return [text];
	const lines: string[] = [];
	for (const paragraph of text.split("\n")) {
		if (paragraph.length <= maxWidth) {
			lines.push(paragraph);
			continue;
		}
		let remaining = paragraph;
		while (remaining.length > maxWidth) {
			let breakAt = remaining.lastIndexOf(" ", maxWidth);
			if (breakAt <= 0) breakAt = maxWidth;
			lines.push(remaining.slice(0, breakAt));
			remaining = remaining.slice(breakAt).trimStart();
		}
		if (remaining) lines.push(remaining);
	}
	return lines;
}

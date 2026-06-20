/**
 * Splice-by-range editing for the command model. Edits replace only
 * the byte ranges they target, so every untouched byte of the
 * source survives identically. This is the safety guarantee: the
 * model never reconstructs a command from parsed pieces.
 */

import type { Span } from "./types.js";

/** A replacement of one source range with new text. */
export interface Edit {
	readonly span: Span;
	readonly text: string;
}

/** Apply edits to the source, splicing only the targeted ranges. */
export function applyEdits(source: string, edits: Edit[]): string {
	if (edits.length === 0) return source;

	const ordered = [...edits].sort((a, b) => a.span.start - b.span.start);
	let result = "";
	let cursor = 0;
	for (const edit of ordered) {
		if (edit.span.start < cursor) {
			throw new Error(
				`overlapping edits: span ${edit.span.start}-${edit.span.end} overlaps a prior edit ending at ${cursor}`,
			);
		}
		result += source.slice(cursor, edit.span.start) + edit.text;
		cursor = edit.span.end;
	}
	return result + source.slice(cursor);
}

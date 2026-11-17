/**
 * A label made fit for one line of the host's journal. A model writes
 * some of what the host journals, a background job's label among them,
 * and a line break in one, or a NUL, which journald also ends a line at,
 * would read as a line of the host's own; an escape would be obeyed by a
 * terminal reading the journal, and a format character, such as a
 * right-to-left override or a zero-width space, would reorder or hide
 * what it shows.
 */

/** The label with every run of whitespace, control or format characters made one space, and trimmed. */
export function oneLine(label: string): string {
	return label.replace(/[\s\p{Cc}\p{Cf}]+/gu, " ").trim();
}

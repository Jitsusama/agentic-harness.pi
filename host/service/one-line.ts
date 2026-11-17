/**
 * A label made fit for one line of the host's journal. A model writes
 * some of what the host journals, a background job's label among them,
 * and a line break in one, or a NUL, which journald also ends a line at,
 * would read as a line of the host's own; an escape would be obeyed by a
 * terminal reading the journal, and a format character, such as a
 * right-to-left override or a zero-width space, would reorder or hide
 * what it shows. The zero-width joiner and non-joiner stay, since they
 * join an emoji or spell a word and reorder nothing. journald cuts a
 * line past its LineMax into a new entry, which a label's tail would
 * open as if the host had said it, so a long label is cut short.
 */

/** The most a label keeps, far short of journald's 48K LineMax even several to a line. */
export const LABEL_MAX_CHARS = 300;

/** What a cut label ends with. */
const CUT = "...";

/** Whitespace, control and format characters, but for the two joiners. */
const BREAKING = /(?:(?![\u200c\u200d])[\s\p{Cc}\p{Cf}])+/gu;

/** The label with every run of whitespace, control or format characters made one space, trimmed and cut short. */
export function oneLine(label: string): string {
	const line = label.replace(BREAKING, " ").trim();
	if (line.length <= LABEL_MAX_CHARS) return line;
	return `${line.slice(0, LABEL_MAX_CHARS - CUT.length).trimEnd()}${CUT}`;
}

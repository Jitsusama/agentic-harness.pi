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
 * open as if the host had said it, so a long label is cut short, never
 * between a character's two halves, and a list of them names only its
 * first few.
 */

/** The most a label keeps, in UTF-16 code units, far short of journald's 48K LineMax even several to a line. */
export const LABEL_MAX_CHARS = 300;

/**
 * The most labels one line names: at three bytes a code unit, twenty
 * labels at their longest come to about 18 KB, under journald's 48K.
 */
export const LABELS_MOST = 20;

/** What a cut label ends with. */
const CUT = "...";

/** Whitespace, control and format characters, but for the two joiners. */
const BREAKING = /(?:(?![\u200c\u200d])[\s\p{Cc}\p{Cf}])+/gu;

/** The label with every run of whitespace, control or format characters made one space, trimmed and cut short. */
export function oneLine(label: string): string {
	const line = label.replace(BREAKING, " ").trim();
	if (line.length <= LABEL_MAX_CHARS) return line;
	const kept = line.slice(0, LABEL_MAX_CHARS - CUT.length);
	// A lone high half would reach the journal as a replacement character.
	const whole = isHighHalf(kept.charCodeAt(kept.length - 1))
		? kept.slice(0, -1)
		: kept;
	return `${whole.trimEnd()}${CUT}`;
}

/** The labels, each made one line, the first LABELS_MOST joined by "; ", counting the rest. */
export function oneLineOf(labels: readonly string[]): string {
	const named = labels.slice(0, LABELS_MOST).map(oneLine).join("; ");
	const rest = labels.length - LABELS_MOST;
	return rest > 0 ? `${named}; and ${rest} more` : named;
}

/** The first of a surrogate pair's two code units. */
const HIGH_HALF = { from: 0xd800, to: 0xdbff };

/** Whether a UTF-16 code unit opens a surrogate pair. */
function isHighHalf(unit: number): boolean {
	return unit >= HIGH_HALF.from && unit <= HIGH_HALF.to;
}

/**
 * Which characters draw as nothing: what a line shows nobody but a model
 * may still read. One copy, for the mesh's subjects and the words a
 * sprout relays from mycelium, so the two can't drift apart.
 */

/** Every format character: bidi marks, zero widths, tags, the BOM. */
const FORMAT = /\p{Cf}/u;

/**
 * The code points, first and last, the node counts as unseen that
 * aren't format characters: the grapheme joiner, the Hangul and Khmer
 * fillers, the variation selectors, Mongolian or not, and the code
 * points left unassigned among the invisible operators and the tags.
 * Ranges rather than a character class, since most are combining marks,
 * which a class would join to their neighbours.
 */
const UNSEEN: readonly (readonly [number, number])[] = [
	[0x034f, 0x034f],
	[0x115f, 0x1160],
	[0x17b4, 0x17b5],
	[0x180b, 0x180f],
	[0x2060, 0x2065],
	[0x3164, 0x3164],
	[0xfe00, 0xfe0f],
	[0xffa0, 0xffa0],
	[0xe0000, 0xe007f],
	[0xe0100, 0xe01ef],
];

/**
 * Whether one character (a code point, as `Array.from` splits a string)
 * draws as nothing: a format character, or one in `UNSEEN`.
 */
export function drawsAsNothing(each: string): boolean {
	const point = each.codePointAt(0) ?? 0;
	return (
		FORMAT.test(each) ||
		UNSEEN.some(([first, last]) => point >= first && point <= last)
	);
}

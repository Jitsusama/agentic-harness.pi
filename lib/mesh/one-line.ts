/**
 * Text another session wrote, held to one line where a listing says it.
 * A presence, a lease board, a queue record or a refused wake says its
 * strings as it likes, and a reader takes each line of a listing as one
 * peer's, so nothing written there may start a line of its own or hide
 * inside one. JavaScript's `\s` covers the breaks a model splits on, U+2028
 * and U+2029 among them, but a terminal or another reader also breaks on
 * NEL (U+0085) and redraws on an escape sequence, both control characters
 * (Cc). Every format character (Cf) counts as a break too: the bidi
 * controls, marks as well as overrides, which reorder what is around
 * them; the zero-width characters and word joiner, which hide a
 * boundary; and the tag characters, which a person never sees and a
 * model reads as text. Folding them costs a joined emoji or a soft hyphen
 * in what a peer says it works on, which a listing can spare.
 */

/** A run of what may break, rearrange or hide inside a line, as one class. */
const BREAK = "[\\s\\p{Cc}\\p{Cf}]";
const BREAKS = new RegExp(`${BREAK}+`, "gu");
const HAS_BREAK = new RegExp(BREAK, "u");

/** Text said on one line, however many it came on. */
export function oneLine(text: string): string {
	return text.replace(BREAKS, " ").trim();
}

/** Whether text is one word, with nothing in it that could break a line. */
export function isWord(text: string): boolean {
	return text.length > 0 && !HAS_BREAK.test(text);
}

/** A machine's or a tool's name: letters and digits, joined by `.`, `_` or `-`. */
const NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

/** A quest id, wherever it stands in a name. */
const QUEST_IN = /QEST-\d{8}-/i;

/**
 * Whether text is a name a listing may print inside a peer's own line,
 * as a machine or a tool goes by. A deny-list of breaks can't hold it:
 * punctuation and blank-looking letters print as a field of their own,
 * so a name is held to the shape names have, and never carries a quest
 * id, since a reader takes the quest a peer line names as that peer's.
 */
export function isName(text: string): boolean {
	return NAME.test(text) && !QUEST_IN.test(text);
}

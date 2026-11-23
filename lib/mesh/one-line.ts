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
 * model reads as text. The variation selectors carry text the same
 * unseen way, a byte each hung off any letter, though Unicode files them
 * as marks (Mn), so both of their blocks are named here; so are the
 * letters and symbol that draw as nothing, the Hangul fillers and the
 * blank Braille pattern. Folding them costs a joined emoji, an emoji's
 * chosen style or a soft hyphen in what a peer says it works on, which a
 * listing can spare.
 */

/** A run of what may break, rearrange or hide inside a line, as one class. */
const BREAK =
	"[\\s\\p{Cc}\\p{Cf}\\uFE00-\\uFE0F\\u{E0100}-\\u{E01EF}\\u115F\\u1160\\u3164\\uFFA0\\u2800]";
const BREAKS = new RegExp(`${BREAK}+`, "gu");

/** Text said on one line, however many it came on. */
export function oneLine(text: string): string {
	return text.replace(BREAKS, " ").trim();
}

/**
 * A machine's or a tool's name: letters and digits, joined by `.`, `_` or
 * `-`, and at most 64 long, as a tool's name is held to and a machine's
 * short name fits in, so none can flood the line it is printed in.
 */
const NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;

/**
 * A quest id, wherever it stands in a name and however it is joined,
 * since a reader taking a near spelling for the id is a model.
 */
const QUEST_IN = /QEST[-_.]?\d{8}/i;

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

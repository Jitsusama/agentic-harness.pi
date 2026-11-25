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
 * as marks (Mn), so both of their blocks are named here, as are the
 * Mongolian free variation selectors; so are the marks, letters and
 * symbol that draw as nothing, the combining grapheme joiner, the Khmer
 * inherent vowels, the Hangul fillers and the blank Braille pattern.
 * These are the cases known, not every one: a code point that draws as
 * nothing and is none of these still passes, though it can't break a
 * line, since every break is `\s`, Cc or Cf. Folding them costs a joined
 * emoji, an emoji's chosen style or a soft hyphen in what a peer says it
 * works on, which a listing can spare.
 */

/** A run of what may break, rearrange or hide inside a line, as one class. */
const BREAK =
	"[\\s\\p{Cc}\\p{Cf}\\uFE00-\\uFE0F\\u{E0100}-\\u{E01EF}\\u180B-\\u180F\\u034F\\u17B4\\u17B5\\u115F\\u1160\\u3164\\uFFA0\\u2800]";
const BREAKS = new RegExp(`${BREAK}+`, "gu");

/** Text said on one line, however many it came on. */
export function oneLine(text: string): string {
	return text.replace(BREAKS, " ").trim();
}

/**
 * The quotes and backticks a reader may take for those that close a
 * quoted string or a code span: the curly, low, reversed, angle and
 * fullwidth quotes, primes and modifier letters that draw as one, and
 * the backtick and its lookalikes, the quote ornaments among them,
 * past the basic plane too, every corner bracket Unicode counts as a
 * quotation mark, and each mark's canonical twin, as the Greek varia
 * is a backtick's. Others may draw as one in some font; these are the
 * ones Unicode names as quotes or draws so.
 * A peer's words said inside quotes or a
 * code span have each of these as `'`, which closes neither, since
 * JSON escapes only the straight double quote and a model reads the
 * rest as closing it too.
 */
const QUOTE_LIKE =
	/["`\u2018-\u201F\u2032-\u2037\u02B9-\u02BC\u02C8\u02CA\u02CB\u02F4\u00B4\u0374\u1FEF\u1FFD\u2035\uFF02\uFF07\uFF40\uFF62\uFF63\u300C-\u300F\uFE41-\uFE44\u275B-\u2760\u{1F676}-\u{1F678}\u301D-\u301F\u00AB\u00BB\u2039\u203A\u2E42\u02EE\uA78B\uA78C]/gu;

/** Text with every quote or backtick a reader may take as closing one as `'`. */
export function plainQuotes(text: string): string {
	return text.replace(QUOTE_LIKE, "'");
}

/**
 * A machine's or a tool's name: letters and digits, joined by `.`, `_` or
 * `-`, and at most 64 long, as a tool's name is held to and a machine's
 * short name fits in, so none can flood the line it is printed in.
 */
const NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;

/**
 * A quest id's opening, wherever it stands in a name, however its
 * digits follow: joined by any run of `-`, `_` or `.`, or split
 * themselves, since a reader taking a near spelling for the id is a
 * model. No machine or tool is named with it otherwise.
 */
const QUEST_IN = /QEST/i;

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

/**
 * Text cut to `most` characters with `...` after, counted whole, so a
 * cut never splits a character past the basic plane in two; text at
 * the bound or under is kept as it is.
 */
export function cutWhole(text: string, most: number): string {
	const each = [...text];
	return each.length > most ? `${each.slice(0, most).join("")}...` : text;
}

/**
 * Text cut to `most` whole characters with `...` in the middle, keeping
 * its head and its tail: for names such as paths, which share a long
 * head and differ only at the end. Text at the bound or under is kept
 * as it is.
 */
export function cutMiddle(text: string, most: number): string {
	const each = [...text];
	if (each.length <= most) return text;
	const head = Math.ceil(most / 2);
	const tail = each.slice(each.length - (most - head));
	return `${each.slice(0, head).join("")}...${tail.join("")}`;
}

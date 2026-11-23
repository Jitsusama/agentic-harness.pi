/**
 * Text another session wrote, held to one line where a listing says it.
 * A presence, a lease board or a queue record says its strings as it
 * likes, and a reader takes each line of a listing as one peer's, so
 * nothing written there may start a line of its own. JavaScript's `\s`
 * covers the breaks a model splits on, but a terminal or another reader
 * also breaks on NEL (U+0085), redraws on an escape sequence and
 * reorders around a bidi override, so every control character and bidi
 * control counts as a break too.
 */

/** A run of what may break or rearrange a line, as one class. */
const BREAK = "[\\s\\p{Cc}\\u202A-\\u202E\\u2066-\\u2069]";
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

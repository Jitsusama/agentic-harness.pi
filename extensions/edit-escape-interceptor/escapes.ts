/**
 * Reading an edit's `\uXXXX` escapes as the characters they name, where
 * that is plainly what was meant.
 *
 * A model writing an edit for a file holding `→` or `§` sometimes spells
 * the character as its JSON escape, six characters of text, and the
 * match fails: eleven times in one session on 18 October, each costing a
 * retry, until the agent learnt to anchor its edits around the character.
 * The same escape in a replacement goes unnoticed and lands in the file as
 * `\u2192`, which is worse.
 *
 * So an edit whose old text is not in the file as written, but is once its
 * escapes are read, is read that way, replacement included. Only then: an
 * old text that matches as written is left alone, since a file of source
 * code may hold escapes on purpose. And the replacement keeps its escapes
 * when the file already holds some, since there they may be meant as text.
 */

/** A `\uXXXX` escape, as JSON and JavaScript spell one. */
const ESCAPE = /\\u([0-9a-fA-F]{4})/g;

/** Whether this text spells any character as an escape. */
export function hasEscapes(text: string): boolean {
	return /\\u[0-9a-fA-F]{4}/.test(text);
}

/**
 * Text with each escape read as its character. A surrogate pair, two
 * escapes, makes the one character it encodes.
 */
export function unescaped(text: string): string {
	return text.replace(ESCAPE, (_, hex: string) =>
		String.fromCharCode(Number.parseInt(hex, 16)),
	);
}

/** One replacement in an edit, as pi's edit tool takes it. */
export interface Replacement {
	oldText: string;
	newText: string;
}

/**
 * These replacements with escapes read where the file shows they were meant
 * as characters. Returns how many were changed; the replacements are changed
 * in place, as a `tool_call` handler changes a call's input.
 */
export function readEscapes(content: string, edits: Replacement[]): number {
	const literal = hasEscapes(content);
	let changed = 0;
	for (const edit of edits) {
		if (!hasEscapes(edit.oldText) || content.includes(edit.oldText)) continue;
		const meant = unescaped(edit.oldText);
		if (!content.includes(meant)) continue;
		edit.oldText = meant;
		if (!literal) edit.newText = unescaped(edit.newText);
		changed += 1;
	}
	return changed;
}

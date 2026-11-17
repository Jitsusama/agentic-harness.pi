/**
 * The scrub's marks written back into a file: what a write or an edit
 * would put down that stood, in the agent's copy, where a credential was.
 *
 * An agent that read a file through the scrub, a `.env` among them, holds
 * the file with each credential replaced by a mark. Writing that copy
 * back, whole or through an edit, puts the mark in the file in place of
 * the credential, and the credential is gone. So a write or an edit that
 * would leave the file holding a mark more often than it does now is
 * refused, naming why. Marks are counted, not only looked for, since a
 * file that quotes a mark may also hold a credential the scrub showed as
 * that same mark. So a mark the file already holds, as a test of the
 * scrub quotes one, is kept or moved freely, but one more copy of it is
 * refused too; code that needs one builds it from pieces. An edit whose
 * old text holds a mark the file doesn't hold already fails to match.
 */

/**
 * The words that stand where a secret was, as `scrubbedMark` makes them:
 * a kind in words, or a variable's name. Words about the shape, as its
 * pattern or a template for it, are no mark.
 */
const MARK = /\[secret scrubbed: [A-Za-z0-9_ ]+\]/g;

/** How many times each mark appears in a text. */
function marksIn(text: string): Map<string, number> {
	const counts = new Map<string, number>();
	for (const [mark] of text.matchAll(MARK)) {
		counts.set(mark, (counts.get(mark) ?? 0) + 1);
	}
	return counts;
}

/**
 * The marks `after` holds more of than `before` does, each once, in the
 * order `after` first holds them; none when it adds none.
 */
export function marksAdded(before: string, after: string): string[] {
	const had = marksIn(before);
	const added: string[] = [];
	for (const [mark, count] of marksIn(after)) {
		if (count > (had.get(mark) ?? 0)) added.push(mark);
	}
	return added;
}

/** One replacement of an edit, as pi's edit tool takes it. */
export interface MarkedEdit {
	readonly oldText: string;
	readonly newText: string;
}

/** A text with its `\uXXXX` escapes spelled out, as an edit may send it. */
function spelledOut(text: string): string {
	return text.replace(/\\u([0-9a-fA-F]{4})/g, (_escape, code: string) =>
		String.fromCharCode(Number.parseInt(code, 16)),
	);
}

/**
 * The file an edit leaves, each old text matching the file once and none
 * overlapping, as pi applies them; undefined when one doesn't.
 */
function edited(held: string, edits: readonly MarkedEdit[]): string | undefined {
	const places: { at: number; edit: MarkedEdit }[] = [];
	for (const edit of edits) {
		const at = held.indexOf(edit.oldText);
		if (edit.oldText === "" || at < 0) return undefined;
		if (held.indexOf(edit.oldText, at + 1) >= 0) return undefined;
		places.push({ at, edit });
	}
	places.sort((a, b) => a.at - b.at);
	let out = "";
	let from = 0;
	for (const { at, edit } of places) {
		if (at < from) return undefined;
		out += held.slice(from, at) + edit.newText;
		from = at + edit.oldText.length;
	}
	return out + held.slice(from);
}

/**
 * The marks an edit would add to the file, which holds `held`: judged on
 * the whole file it leaves, so replacements beside each other, or a
 * file's text beside one, can't make a mark unseen, with any `\uXXXX`
 * escape spelled out, as the edit escape interceptor may first rewrite
 * one. When an old text doesn't match the file once, pi refuses the edit
 * anyway, and its new texts are judged against its old ones.
 */
export function marksEditAdds(
	held: string,
	edits: readonly MarkedEdit[],
): string[] {
	const spelled = edits.map((edit) => ({
		oldText: spelledOut(edit.oldText),
		newText: spelledOut(edit.newText),
	}));
	const whole = edited(held, spelled);
	if (whole !== undefined) return marksAdded(held, whole);
	return marksAdded(
		spelled.map((edit) => edit.oldText).join("\n"),
		spelled.map((edit) => edit.newText).join("\n"),
	);
}

/** Why a write or an edit that would add `marks` is refused. */
export function markRefusal(marks: readonly string[]): string {
	const named = marks.map((mark) => `\`${mark}\``).join(", ");
	return [
		`Refused: this would write ${named} into the file more often than it holds it now.`,
		"The secret scrub put that mark where a credential was in what you read; written back, it replaces the credential, which is then lost.",
		"Leave that span as the file has it: edit around it, or ask the person for what belongs there.",
		'Code or a test that quotes a mark builds it from pieces, as `[secret ${"scrubbed"}: kind]`.',
	].join(" ");
}

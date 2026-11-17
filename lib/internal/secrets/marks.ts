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

/** A `\uXXXX` escape, as JSON and JavaScript spell one. */
const ESCAPE = /\\u([0-9a-fA-F]{4})/g;

/** A text with its `\uXXXX` escapes spelled out, as an edit may send it. */
function spelledOut(text: string): string {
	return text.replace(ESCAPE, (_escape, code: string) =>
		String.fromCharCode(Number.parseInt(code, 16)),
	);
}

/**
 * The edit as the edit escape interceptor leaves it: an old text missing
 * from the file as written but there once its escapes are read is read
 * that way, and its new text too unless the file holds escapes itself
 * (`extensions/edit-escape-interceptor/escapes.ts`).
 */
function escapesRead(held: string, edits: readonly MarkedEdit[]): MarkedEdit[] {
	const literal = /\\u[0-9a-fA-F]{4}/.test(held);
	return edits.map((edit) => {
		if (held.includes(edit.oldText)) return edit;
		const meant = spelledOut(edit.oldText);
		if (meant === edit.oldText || !held.includes(meant)) return edit;
		return {
			oldText: meant,
			newText: literal ? edit.newText : spelledOut(edit.newText),
		};
	});
}

/** A text with its line endings made `\n`, as pi's edit reads both sides. */
function lineFed(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * A text as pi's edit matches it when an old text misses as written:
 * trailing spaces gone, curly quotes, dashes and unicode spaces made
 * plain (pi-coding-agent's `normalizeForFuzzyMatch`).
 */
function loosened(text: string): string {
	return text
		.normalize("NFKC")
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
		.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
		.replace(/[\u2010-\u2015\u2212]/g, "-")
		.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

/** The file before and after an edit, in the form pi applied it to. */
interface Replayed {
	readonly before: string;
	readonly after: string;
}

/**
 * The file an edit leaves, replayed as pi's edit applies one: a byte
 * order mark dropped, line endings made `\n`, each old text found once,
 * as written or else loosely, and none overlapping; undefined when pi
 * would refuse it.
 */
function edited(
	held: string,
	edits: readonly MarkedEdit[],
): Replayed | undefined {
	const content = lineFed(held.replace(/^\uFEFF/, ""));
	const fed = edits.map((edit) => ({
		oldText: lineFed(edit.oldText),
		newText: lineFed(edit.newText),
	}));
	if (fed.some((edit) => edit.oldText === "")) return undefined;
	const loose = fed.some((edit) => !content.includes(edit.oldText));
	const before = loose ? loosened(content) : content;
	const places: { at: number; length: number; newText: string }[] = [];
	for (const edit of fed) {
		const exact = before.indexOf(edit.oldText);
		const old = exact < 0 ? loosened(edit.oldText) : edit.oldText;
		const at = exact < 0 ? before.indexOf(old) : exact;
		if (at < 0) return undefined;
		const found = loosened(before).split(loosened(edit.oldText)).length - 1;
		if (found > 1) return undefined;
		places.push({ at, length: old.length, newText: edit.newText });
	}
	places.sort((a, b) => a.at - b.at);
	let after = "";
	let from = 0;
	for (const { at, length, newText } of places) {
		if (at < from) return undefined;
		after += before.slice(from, at) + newText;
		from = at + length;
	}
	return { before, after: after + before.slice(from) };
}

/**
 * The marks an edit would add to the file, which holds `held`: judged on
 * the whole file it leaves, replayed as pi applies it, so replacements
 * beside each other, or a file's text beside one, can't make a mark
 * unseen. It is judged as sent and as the edit escape interceptor would
 * read its escapes, since which runs first isn't fixed, and a mark
 * either adds counts. An edit that can't be replayed, which pi refuses,
 * is judged on its new texts against its old ones, run together.
 */
export function marksEditAdds(
	held: string,
	edits: readonly MarkedEdit[],
): string[] {
	const added = new Set<string>();
	for (const reading of [edits, escapesRead(held, edits)]) {
		const whole = edited(held, reading);
		const marks = whole
			? marksAdded(whole.before, whole.after)
			: marksAdded(
					reading.map((edit) => edit.oldText).join(""),
					reading.map((edit) => edit.newText).join(""),
				);
		for (const mark of marks) added.add(mark);
	}
	return [...added];
}

/** Why a write or an edit that would add `marks` is refused. */
export function markRefusal(marks: readonly string[]): string {
	const named = marks.map((mark) => `\`${mark}\``).join(", ");
	return [
		`Refused: this would write ${named} into the file more often than it holds it now.`,
		"The secret scrub put that mark where a credential was in what you read; written back, it replaces the credential, which is then lost.",
		"Leave that span as the file has it: edit around it, or ask the person for what belongs there.",
		`Code or a test that quotes a mark builds it from pieces, as \`[secret \${"scrubbed"}: kind]\`.`,
	].join(" ");
}

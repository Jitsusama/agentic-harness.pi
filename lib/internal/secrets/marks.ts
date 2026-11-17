/**
 * The scrub's marks written back into a file: what a write or an edit
 * would put down that stood, in the agent's copy, where a credential was.
 *
 * An agent that read a file through the scrub, a `.env` among them, holds
 * the file with each credential replaced by a mark. Writing that copy
 * back, whole or through an edit, puts the mark in the file in place of
 * the credential, and the credential is gone. So a write or an edit that
 * would add a mark the file doesn't already hold is refused, naming why.
 * A mark the file already holds, as a test of the scrub quotes one, is
 * written as freely as any other words, and an edit whose old text holds
 * a mark the file doesn't hold already fails to match.
 */

/** The words that stand where a secret was, as `scrubbedMark` makes them. */
const MARK = /\[secret scrubbed: [^\]\n]*\]/g;

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

/**
 * The marks an edit would add to a file: those its new texts hold more of
 * than its old texts, which must each match the file, already do.
 */
export function marksEditAdds(edits: readonly MarkedEdit[]): string[] {
	return marksAdded(
		edits.map((edit) => edit.oldText).join("\n"),
		edits.map((edit) => edit.newText).join("\n"),
	);
}

/** Why a write or an edit that would add `marks` is refused. */
export function markRefusal(marks: readonly string[]): string {
	const named = marks.map((mark) => `\`${mark}\``).join(", ");
	return [
		`Refused: this would write ${named} into the file, which it doesn't hold.`,
		"The secret scrub put that mark where a credential was in what you read; written back, it replaces the credential, which is then lost.",
		"Leave that span as the file has it: edit around it, or ask the person for what belongs there.",
	].join(" ");
}

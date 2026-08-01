/** The column rule prose in this package is held to. */
const DEFAULT_WIDTH = 80;

/**
 * Lines the column rule exempts, which reflowing would damage rather
 * than tidy. A table row means the pipes, and a fenced block's
 * contents are code whose line breaks carry meaning.
 */
function reflowable(line: string): boolean {
	const trimmed = line.trimStart();
	return !(trimmed.startsWith("|") || trimmed.startsWith("```"));
}

/** Greedily fill lines up to `width`, never splitting a word. */
function fill(paragraph: string, width: number): string {
	const lines: string[] = [];
	let current = "";
	for (const word of paragraph.split(/\s+/).filter(Boolean)) {
		if (!current) {
			current = word;
		} else if (current.length + 1 + word.length <= width) {
			current = `${current} ${word}`;
		} else {
			lines.push(current);
			current = word;
		}
	}
	if (current) lines.push(current);
	return lines.join("\n");
}

/**
 * Wrap prose to the column rule, preserving paragraphs and leaving
 * alone the lines the rule exempts.
 *
 * A word longer than the width still goes on its own line and still
 * overflows, because breaking it would change what it says. The rule
 * is about where lines end, not about truncating text.
 */
export function wrapProse(text: string, width = DEFAULT_WIDTH): string {
	return text
		.split(/\n{2,}/)
		.map((paragraph) =>
			paragraph.split("\n").every(reflowable)
				? fill(paragraph, width)
				: paragraph,
		)
		.join("\n\n");
}

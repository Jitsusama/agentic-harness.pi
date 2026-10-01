/**
 * Splitting a message into paragraphs, the unit the selection tags and
 * quotes. A blank line ends a paragraph, except inside a fenced code
 * block, which stays whole however many blank lines it holds.
 */

const FENCE = /^\s*(```|~~~)/;

/** The paragraphs of a text, trimmed, in order, with none empty. */
export function paragraphsOf(text: string): string[] {
	const paragraphs: string[] = [];
	let current: string[] = [];
	let fence: string | null = null;
	const close = () => {
		const paragraph = current.join("\n").trim();
		if (paragraph) paragraphs.push(paragraph);
		current = [];
	};
	for (const line of text.split("\n")) {
		const marker = FENCE.exec(line)?.[1];
		if (fence === null && marker) {
			fence = marker;
		} else if (fence !== null && marker === fence) {
			fence = null;
		} else if (fence === null && line.trim() === "") {
			close();
			continue;
		}
		current.push(line);
	}
	close();
	return paragraphs;
}

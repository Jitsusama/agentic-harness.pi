/**
 * What to say beside an edit whose old text was not found.
 *
 * pi says only that the text did not match. From 15 to 22 October that
 * happened 383 times, and the next call was most often another read or
 * a shell command to look at the file again: a round trip spent finding
 * out what the error could have said. Of the failures whose file still
 * exists, 61 had their new text in the file already (the edit had gone
 * in), and 31 had the first line or every word right but not the rest.
 * So the answer says which: already applied, or here are the lines that
 * come closest, as the file has them now.
 */

/** The most lines quoted back, so a hint never costs more than a read. */
const MOST_LINES = 40;

/** How much of a replacement's trimmed lines a region must hold to be quoted. */
const ENOUGH = 0.5;

/** The text to append to a missed edit's error, or nothing to add. */
export function missedEditHint(
	file: string,
	oldText: string,
	newText: string,
	label: string,
): string | undefined {
	if (
		newText.trim() !== "" &&
		file.includes(newText) &&
		!file.includes(oldText)
	) {
		return `${label}'s new text is already in the file and its old text is not, so it looks already applied. Read the file before editing it again.`;
	}
	const near = nearest(file, oldText);
	if (!near) return undefined;
	const width = String(near.end).length;
	const quoted = near.lines
		.map((line, i) => `${String(near.start + i).padStart(width)}\t${line}`)
		.join("\n");
	return `The lines closest to ${label}'s old text, as the file has them now (line numbers added):\n${quoted}`;
}

interface Region {
	/** First line, counted from 1. */
	start: number;
	end: number;
	lines: string[];
}

/** The region of the file whose lines best cover the old text's lines. */
export function nearest(file: string, oldText: string): Region | undefined {
	const wanted = oldText
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "");
	if (wanted.length === 0) return undefined;
	const lines = file.split("\n");
	const trimmed = lines.map((line) => line.trim());
	const span = Math.min(
		MOST_LINES,
		Math.max(oldText.split("\n").length, wanted.length),
	);
	let best: { start: number; score: number } | undefined;
	for (let start = 0; start < lines.length; start++) {
		if (!wanted.includes(trimmed[start] ?? "")) continue;
		const window = new Set(trimmed.slice(start, start + span));
		const score = wanted.filter((line) => window.has(line)).length;
		if (!best || score > best.score) best = { start, score };
	}
	if (!best || best.score / wanted.length < ENOUGH) return undefined;
	const picked = lines.slice(best.start, best.start + span);
	return {
		start: best.start + 1,
		end: best.start + picked.length,
		lines: picked,
	};
}

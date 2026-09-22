/** A width and a height in pixels. */
export interface Size {
	readonly width: number;
	readonly height: number;
}

/** What pi's own dimension note says. */
export interface DimensionNote extends Size {
	readonly originalWidth: number;
	readonly originalHeight: number;
}

/**
 * pi's note, as it writes it: `[Image: original 3024x1964, displayed at
 * 2000x1299. Multiply coordinates by 1.51 to map to original image.]`
 *
 * Anchored at the start so prose that merely mentions dimensions cannot
 * be mistaken for the note. This investigation has already had one
 * detector match the contents of files discussing a string rather than
 * the string itself.
 */
const NOTE = /^\[Image: original (\d+)x(\d+), displayed at (\d+)x(\d+)\./;

/**
 * The same note wherever it sits, because pi writes it before the image
 * and folds it into the same text block as the tool's own first line.
 * Matched whole, closing bracket included, so prose that merely
 * discusses dimensions cannot be taken for it: a looser detector has
 * already produced one wrong number in this investigation by matching
 * the contents of files that talk about a string.
 */
const NOTE_ANYWHERE =
	/\n?\[Image: original (\d+)x(\d+), displayed at (\d+)x(\d+)\.[^\]]*\]/;

/**
 * Read pi's dimension note, or nothing when the text is not one.
 *
 * This is where the true original size survives. pi resizes before any
 * extension sees the result, so the payload handed over is already
 * shrunk, and a budget computed from it would be a budget against an
 * intermediate. The note is the only record of what the image was.
 */
export function stripDimensionNote(text: string): StrippedNote {
	const found = NOTE_ANYWHERE.exec(text);
	if (!found) return { text, note: null };
	const [, ow, oh, w, h] = found.map(Number);
	if (!ow || !oh || !w || !h) return { text, note: null };
	return {
		text: text.replace(NOTE_ANYWHERE, "").trim(),
		note: { originalWidth: ow, originalHeight: oh, width: w, height: h },
	};
}

/** A text block with pi's note lifted out of it. */
export interface StrippedNote {
	readonly text: string;
	readonly note: DimensionNote | null;
}

/** Lift pi's note out of a block, leaving the rest of the prose. */
export function readDimensionNote(text: string): DimensionNote | null {
	const found = NOTE.exec(text.trim());
	if (!found) return null;
	const [, ow, oh, w, h] = found.map(Number);
	if (!ow || !oh || !w || !h) return null;
	return { originalWidth: ow, originalHeight: oh, width: w, height: h };
}

/**
 * One sentence naming the true original, the size actually sent, and
 * the factor between them.
 *
 * One note replaces pi's rather than sitting beside it. Two notes each
 * telling half the truth are worse than one: with pi reporting a factor
 * to an intermediate and this reporting a change from it, the real
 * factor appears nowhere and a coordinate read off the picture lands in
 * the wrong place.
 */
export function describeScaling(original: Size, sent: Size): string | null {
	if (sent.width <= 0 || sent.height <= 0) return null;
	if (original.width <= 0 || original.height <= 0) return null;
	const factor = original.width / sent.width;
	return (
		`[Image: original ${original.width}x${original.height}, shown at ` +
		`${sent.width}x${sent.height} to fit the context budget. Multiply ` +
		`coordinates by ${factor.toFixed(2)} to map to the original.]`
	);
}

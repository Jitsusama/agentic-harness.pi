import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { billedTokens, fitToBudget } from "./budget.ts";
import {
	type DimensionNote,
	describeScaling,
	type Size,
	stripDimensionNote,
} from "./note.ts";

/** What pi's resizer answers with. */
export interface Resized {
	readonly data: string;
	readonly mimeType: string;
	readonly originalWidth: number;
	readonly originalHeight: number;
	readonly width: number;
	readonly height: number;
	readonly wasResized: boolean;
}

/** The resizer this module needs, which is pi's, narrowed to what it uses. */
export type Resize = (
	bytes: Uint8Array,
	mimeType: string,
	options: { maxWidth: number; maxHeight: number },
) => Promise<Resized | null>;

/**
 * The original bytes, when the caller can reach them. A `read` names a
 * path, so the file on disk is available and re-encoding from it avoids
 * compressing an already-compressed picture a second time. A tool that
 * produced its image in memory has no such source, and the payload is
 * all there is.
 */
export type LoadOriginal = () => Promise<Uint8Array | null>;

/** A block of a tool result, as pi shapes them. */
export type Block = ImageContent | TextContent;

/** What a pass over one tool result did. */
export interface Rebudgeted {
	/** The blocks to answer with, or null when nothing changed. */
	readonly content: Block[] | null;
	/** Billed tokens no longer paid, per turn, for the rest of the session. */
	readonly saved: number;
}

function isImage(block: Block): block is ImageContent {
	return (
		block.type === "image" &&
		typeof block.data === "string" &&
		typeof block.mimeType === "string"
	);
}

/**
 * Take pi's note out of every text block, keeping what it said.
 *
 * pi writes the note before the image and folds it into the same block
 * as the tool's own first line, so it cannot be found by looking beside
 * the image, and leaving it in place would put a stale factor above an
 * accurate one.
 */
function withoutPiNotes(content: readonly Block[]): {
	blocks: Block[];
	note: DimensionNote | null;
} {
	let note: DimensionNote | null = null;
	const blocks: Block[] = [];
	for (const block of content) {
		if (block.type !== "text") {
			blocks.push(block);
			continue;
		}
		const stripped = stripDimensionNote(block.text);
		if (!stripped.note) {
			blocks.push(block);
			continue;
		}
		note ??= stripped.note;
		// A block that was nothing but the note goes entirely, rather than
		// leaving an empty line where it used to be.
		if (stripped.text.length > 0) {
			blocks.push({ type: "text", text: stripped.text });
		}
	}
	return { blocks, note };
}

/**
 * Bring every oversized image in a tool result down to the allowance.
 *
 * The budget is computed from the size pi reports as original, not from
 * the payload handed over. pi resizes before any extension sees a
 * result, so the payload is already an intermediate, and budgeting
 * against it would both understate the reduction and describe the wrong
 * scale to anyone reading a coordinate off the picture.
 *
 * Exactly one note comes out, naming the true original and the size
 * actually sent. pi's note is consumed rather than left beside a second
 * one, because two notes each telling half the truth leave the real
 * factor stated nowhere.
 *
 * Answers with null content when nothing needed changing, which is the
 * common case. Every path that cannot help keeps the original picture:
 * an image the model cannot see is worse than one that costs too much.
 */
export async function rebudget(
	content: readonly Block[],
	resize: Resize,
	loadOriginal?: LoadOriginal,
): Promise<Rebudgeted> {
	const { blocks: incoming, note: piNote } = withoutPiNotes(content);
	const next: Block[] = [];
	let saved = 0;
	let changed = false;

	for (const block of incoming) {
		if (!isImage(block)) {
			next.push(block);
			continue;
		}

		const payload = Buffer.from(block.data, "base64");
		// Prefer the file on disk: re-encoding from the source means one
		// compression rather than two stacked on each other.
		const source = (await loadOriginal?.()) ?? null;
		const bytes = source ?? payload;

		const probe = piNote
			? null
			: await resize(bytes, block.mimeType, {
					maxWidth: Number.MAX_SAFE_INTEGER,
					maxHeight: Number.MAX_SAFE_INTEGER,
				});
		const original: Size | null = piNote
			? { width: piNote.originalWidth, height: piNote.originalHeight }
			: probe
				? { width: probe.originalWidth, height: probe.originalHeight }
				: null;
		const fit = original ? fitToBudget(original.width, original.height) : null;
		if (!original || !fit) {
			next.push(block);
			continue;
		}

		const small = await resize(bytes, block.mimeType, fit);
		if (!small?.wasResized) {
			next.push(block);
			continue;
		}

		// What was being paid was the payload pi handed over, so that is
		// what the saving is measured against.
		const before = piNote
			? billedTokens(piNote.width, piNote.height)
			: billedTokens(small.originalWidth, small.originalHeight);
		saved += before - billedTokens(small.width, small.height);

		next.push({ type: "image", data: small.data, mimeType: small.mimeType });
		const told = describeScaling(original, {
			width: small.width,
			height: small.height,
		});
		if (told) next.push({ type: "text", text: told });
		changed = true;
	}

	// Answering with nothing keeps the result as it arrived, pi's note
	// included. That is what has to happen when a note was lifted out but
	// no image ended up scaled, since dropping it would hide what pi
	// said about an image this extension decided not to touch.
	return { content: changed ? next : null, saved };
}

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { billedTokens, fitToBudget } from "./budget.js";

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

/** A block of a tool result, as pi shapes them. */
export type Block = ImageContent | TextContent;

/** What a pass over one tool result did. */
export interface Rebudgeted {
	/** The blocks to answer with, or null when nothing changed. */
	readonly content: Block[] | null;
	/** Billed tokens no longer being paid, per turn, for the rest of the session. */
	readonly saved: number;
}

/** Widest a dimension note can be before it is not worth the words. */
const NOTE = (r: Resized) =>
	`[Image scaled from ${r.originalWidth}x${r.originalHeight} to ` +
	`${r.width}x${r.height} to fit the context budget. Coordinates in ` +
	`the image map to the scaled size.]`;

function isImage(block: Block): block is ImageContent {
	return (
		block.type === "image" &&
		typeof block.data === "string" &&
		typeof block.mimeType === "string"
	);
}

/**
 * Bring every oversized image in a tool result down to the allowance.
 *
 * Answers with null content when nothing needed changing, which is the
 * common case: an untouched result is not re-encoded, does not pay a
 * second compression, and costs no worker time.
 *
 * A resize that fails or declines leaves the original in place. An image
 * the model cannot see is worse than one that costs too much, so every
 * failure path here keeps the picture.
 */
export async function rebudget(
	content: readonly Block[],
	resize: Resize,
): Promise<Rebudgeted> {
	const next: Block[] = [];
	let saved = 0;
	let changed = false;

	for (const block of content) {
		if (!isImage(block)) {
			next.push(block);
			continue;
		}

		const bytes = Buffer.from(block.data, "base64");
		// Ask for a resize that cannot bind, purely to learn the size pi's
		// decoder reports. Cheaper than carrying an image decoder here,
		// and it is the same decoder that will do the real work.
		const probe = await resize(bytes, block.mimeType, {
			maxWidth: Number.MAX_SAFE_INTEGER,
			maxHeight: Number.MAX_SAFE_INTEGER,
		});
		const fit = probe
			? fitToBudget(probe.originalWidth, probe.originalHeight)
			: null;
		if (!probe || !fit) {
			next.push(block);
			continue;
		}

		const small = await resize(bytes, block.mimeType, fit);
		if (!small?.wasResized) {
			next.push(block);
			continue;
		}

		saved +=
			billedTokens(small.originalWidth, small.originalHeight) -
			billedTokens(small.width, small.height);
		next.push({ type: "image", data: small.data, mimeType: small.mimeType });
		// Say what happened, so a caller reasoning about a position in the
		// picture maps it to the scale the picture is actually at.
		next.push({ type: "text", text: NOTE(small) });
		changed = true;
	}

	return { content: changed ? next : null, saved };
}

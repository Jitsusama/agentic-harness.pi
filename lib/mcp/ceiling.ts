import { joinTextContent, spillToFile } from "./content.js";
import type { McpContent, McpToolResult } from "./types.js";

/** A byte ceiling at or above the 200KB soft default, so it never tightens an already-capped tool. */
export const DEFAULT_RESULT_CEILING_BYTES = 256 * 1024;

/** Where a spilled payload landed: a path to read, and an optional queryable handle. */
export interface SpillTarget {
	path: string;
	handle?: string;
}

/** Where and how hard to cap a result's model-facing content. */
export interface CeilingOptions {
	limitBytes: number;
	/** A directory to spill an oversized payload into, used when `spill` is absent. */
	storageDir?: string;
	/** Spill the full payload and return where it landed; throws on failure. Preferred over `storageDir`. */
	spill?: (text: string) => SpillTarget;
}

/** How a resource_link is rendered to the model by toAgentContent. */
function resourceLinkText(uri: string): string {
	return `[resource: ${uri}]`;
}

/**
 * Sum the model-facing bytes of a result's content blocks: the utf-8 size of
 * text, the base64 length of an image, and the rendered length of a
 * resource_link. Audio and embedded resource blocks are dropped before the
 * model and so count as zero, matching what toAgentContent forwards.
 */
export function contentByteSize(content: McpContent[]): number {
	let total = 0;
	for (const block of content) {
		if (block.type === "text") total += Buffer.byteLength(block.text, "utf-8");
		else if (block.type === "image") total += block.data.length;
		else if (block.type === "resource_link")
			total += Buffer.byteLength(resourceLinkText(block.uri), "utf-8");
	}
	return total;
}

/**
 * Cap a result's aggregate model-facing content to a byte limit.
 *
 * Under the limit the content passes through untouched. Over it, the full raw
 * payload is spilled to disk (fail-closed: a spill failure never returns the
 * raw content), binary blocks are dropped rather than sliced, the text is
 * byte-sliced on a character boundary to a bounded head, and a notice block
 * reports the original size and where the remainder lives. The returned content
 * is guaranteed to measure at or below the limit.
 */
export function enforceResultCeiling(
	shaped: McpContent[],
	raw: McpToolResult,
	opts: CeilingOptions,
): McpContent[] {
	const originalBytes = contentByteSize(shaped);
	if (originalBytes <= opts.limitBytes) return shaped;

	// Only the text carries into a spill; a result with no text (binary only) has
	// nothing meaningful to save, so the notice must say the content was dropped
	// rather than claim an empty file holds it.
	const rawText = joinTextContent(raw);
	const spill = rawText.length > 0 ? trySpill(rawText, opts) : undefined;
	const droppedImages = shaped.filter((b) => b.type === "image").length;
	const notice = sliceUtf8(
		ceilingNotice({
			limitBytes: opts.limitBytes,
			originalBytes,
			spill,
			droppedImages,
		}),
		opts.limitBytes,
	);

	const headBudget = Math.max(
		0,
		opts.limitBytes - Buffer.byteLength(notice, "utf-8"),
	);
	const head = sliceUtf8(textFacing(shaped), headBudget);

	const out: McpContent[] = [];
	if (head.length > 0) out.push({ type: "text", text: head });
	out.push({ type: "text", text: notice });
	return out;
}

/** The text a result contributes to the model: text blocks verbatim, resource_link rendered, binary dropped. */
function textFacing(content: McpContent[]): string {
	const parts: string[] = [];
	for (const block of content) {
		if (block.type === "text") parts.push(block.text);
		else if (block.type === "resource_link")
			parts.push(resourceLinkText(block.uri));
	}
	return parts.join("\n");
}

/** The outcome of a spill: where it landed on success, or an error message on failure. */
type SpillOutcome = SpillTarget | { error: string };

function trySpill(text: string, opts: CeilingOptions): SpillOutcome {
	const dir = opts.storageDir;
	const spill =
		opts.spill ??
		(dir
			? (t: string): SpillTarget => ({ path: spillToFile(t, dir) })
			: undefined);
	if (!spill) return { error: "no storage location configured" };
	try {
		return spill(text);
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

function ceilingNotice(info: {
	limitBytes: number;
	originalBytes: number;
	spill: SpillOutcome | undefined;
	droppedImages: number;
}): string {
	const dropped =
		info.droppedImages > 0
			? ` ${info.droppedImages} image block(s) omitted.`
			: "";
	const fate = spillFate(info.originalBytes, info.spill);
	return `[Result capped at ${info.limitBytes} bytes. ${fate}${dropped}]`;
}

/** Describe where the full payload went, naming the queryable handle when the spill produced one. */
function spillFate(
	originalBytes: number,
	spill: SpillOutcome | undefined,
): string {
	if (spill === undefined)
		return `The ${originalBytes} bytes were non-text content and were dropped.`;
	if ("error" in spill)
		return `The full ${originalBytes}-byte result could not be saved (${spill.error}) and the remainder was dropped.`;
	const where = spill.handle
		? `saved under handle ${spill.handle} (${spill.path})`
		: `saved to ${spill.path}`;
	return `The full ${originalBytes}-byte result was ${where}. Read or query it for the remainder.`;
}

/** Slice text to at most `maxBytes` utf-8 bytes without splitting a multi-byte character. */
function sliceUtf8(text: string, maxBytes: number): string {
	const buf = Buffer.from(text, "utf-8");
	if (buf.length <= maxBytes) return text;
	let end = maxBytes;
	while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
	return buf.toString("utf-8", 0, end);
}

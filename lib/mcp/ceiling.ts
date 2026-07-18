import { joinTextContent, spillToFile } from "./content.js";
import type { McpContent, McpToolResult } from "./types.js";

/** A byte ceiling at or above the 200KB soft default, so it never tightens an already-capped tool. */
export const DEFAULT_RESULT_CEILING_BYTES = 256 * 1024;

/** Where and how hard to cap a result's model-facing content. */
export interface CeilingOptions {
	limitBytes: number;
	storageDir?: string;
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

	const spill = trySpill(joinTextContent(raw), opts.storageDir);
	const droppedImages = shaped.filter((b) => b.type === "image").length;
	const notice = ceilingNotice({
		limitBytes: opts.limitBytes,
		originalBytes,
		spill,
		droppedImages,
	});

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

/** The outcome of a spill: a path on success, or an error message on failure. */
type SpillOutcome = { path: string } | { error: string };

function trySpill(text: string, dir: string | undefined): SpillOutcome {
	if (!dir) return { error: "no storage location configured" };
	try {
		return { path: spillToFile(text, dir) };
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

function ceilingNotice(info: {
	limitBytes: number;
	originalBytes: number;
	spill: SpillOutcome;
	droppedImages: number;
}): string {
	const dropped =
		info.droppedImages > 0
			? ` ${info.droppedImages} image block(s) omitted.`
			: "";
	const fate =
		"path" in info.spill
			? `The full ${info.originalBytes}-byte result was saved to ${info.spill.path}. Read or query that file for the remainder.`
			: `The full ${info.originalBytes}-byte result could not be saved (${info.spill.error}) and the remainder was dropped.`;
	return `[Result capped at ${info.limitBytes} bytes. ${fate}${dropped}]`;
}

/** Slice text to at most `maxBytes` utf-8 bytes without splitting a multi-byte character. */
function sliceUtf8(text: string, maxBytes: number): string {
	const buf = Buffer.from(text, "utf-8");
	if (buf.length <= maxBytes) return text;
	let end = maxBytes;
	while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
	return buf.toString("utf-8", 0, end);
}

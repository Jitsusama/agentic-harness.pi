import { MINTED_HANDLE_SHAPE } from "../result/store.js";
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
	/** A caller-specific next step appended to the notice, e.g. how to ask for less. */
	guidance?: string;
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
 * reports the original size and where the remainder lives.
 *
 * The returned content measures at or below the limit whenever the notice
 * fits, which is every realistic case. The notice itself is never truncated,
 * so a limit too small to hold it yields just the notice, slightly over
 * budget: a handle cut in half reads like a handle and resolves to nothing,
 * which is a worse outcome than a few bytes over.
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
	// The notice is never sliced. It is the only thing that says where
	// the payload went, and half a handle still looks like a handle:
	// a caller reads it, queries it, and is told it does not exist.
	// Slicing it here cost exactly that, and only became visible when
	// a handle grew by one byte and crossed a tight limit.
	//
	// So the head absorbs the whole cost, down to nothing, and in the
	// pathological case where the notice alone is longer than the
	// limit the notice still wins. An answer slightly over budget that
	// can be followed beats one inside budget that cannot.
	const notice = ceilingNotice({
		limitBytes: opts.limitBytes,
		originalBytes,
		spill,
		droppedImages,
		guidance: opts.guidance,
	});

	const headBudget = Math.max(
		0,
		opts.limitBytes - Buffer.byteLength(notice, "utf-8"),
	);
	const head = headWithin(shaped, headBudget);

	const out: McpContent[] = [];
	if (head.length > 0) out.push({ type: "text", text: head });
	out.push({ type: "text", text: notice });
	return out;
}

/**
 * As much of the head as the budget allows, never cutting a block
 * that cites a handle.
 *
 * A block naming a handle is all-or-nothing. Sliced, it hands back
 * a prefix that reads exactly like a handle, and a caller who
 * queries it is told it does not exist, with no way to tell a cut
 * handle from an expired one. This is not hypothetical: the
 * summary an upstream layer had already stashed behind a handle
 * arrived here as ordinary head text, got sliced, and CI failed
 * asking the store for two thirds of a name. It passed locally,
 * because the notice includes a path and a temp directory on one
 * machine is longer than on another, which moved the cut.
 *
 * Everything else slices as before, so the byte guarantee holds.
 */
function headWithin(content: McpContent[], budget: number): string {
	const kept: string[] = [];
	let spent = 0;
	for (const part of textParts(content)) {
		const cost = Buffer.byteLength(part, "utf-8") + (kept.length > 0 ? 1 : 0);
		if (CITES_A_HANDLE.test(part)) {
			// Whole or not at all. Dropping it loses nothing a caller can
			// follow, because the notice below names a handle for the same
			// payload.
			if (spent + cost <= budget) {
				kept.push(part);
				spent += cost;
			}
			continue;
		}
		const room = budget - spent - (kept.length > 0 ? 1 : 0);
		if (room <= 0) break;
		const slice = sliceUtf8(part, room);
		if (slice.length === 0) break;
		kept.push(slice);
		spent += Buffer.byteLength(slice, "utf-8") + (kept.length > 1 ? 1 : 0);
	}
	return kept.join("\n");
}

/**
 * A block that names a handle somebody is meant to be able to use.
 *
 * Matched against the shape the store actually mints, not against
 * the word and whatever follows it. The loose form treated "handle
 * errors gracefully" as a citation, and because such a block is
 * kept whole or dropped, an ordinary sentence about error handling
 * cost the caller their entire preview. Tied to the store's own
 * constant so the two cannot drift apart silently: a handle shape
 * that changed here without changing there would quietly stop
 * being protected.
 */
const CITES_A_HANDLE = new RegExp(`handle ${MINTED_HANDLE_SHAPE}`);

/** The model-facing text of each block, in order. */
function textParts(content: McpContent[]): string[] {
	const parts: string[] = [];
	for (const block of content) {
		if (block.type === "text") parts.push(block.text);
		else if (block.type === "resource_link")
			parts.push(resourceLinkText(block.uri));
	}
	return parts;
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
	guidance?: string;
}): string {
	const dropped =
		info.droppedImages > 0
			? ` ${info.droppedImages} image block(s) omitted.`
			: "";
	const fate = spillFate(info.originalBytes, info.spill);
	const guidance = info.guidance ? ` ${info.guidance}` : "";
	return `[Result capped at ${info.limitBytes} bytes. ${fate}${dropped}${guidance}]`;
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

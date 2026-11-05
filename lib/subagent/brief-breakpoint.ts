/**
 * Where one round's reviewers stop sharing a request.
 *
 * Every reviewer of a round is sent the same brief, and then the few
 * lines that are its own. Anthropic caches a prefix only where a
 * request marks one, and pi marks the end of the last message, which
 * for a reviewer's first call is the end of its own lines: so each
 * reviewer wrote the whole brief to the cache under a key nobody else
 * would ever ask for, and read back only the tool list. A round of four
 * paid for the brief four times.
 *
 * This marks the end of the brief as well, so the first reviewer's
 * write is a prefix the other three can read. The brief is what pi
 * reads from `@file` arguments, which it puts at the head of the first
 * message as `<file>` elements; what comes after the last of them is
 * the message typed on the command line, the part that differs.
 *
 * No imports, because a reviewer loads this into its own process on
 * every request and needs nothing else from the library to do it.
 */

/** How pi closes the text of a file it was handed with `@`. */
const FILE_CLOSE = "\n</file>\n";

/** How pi opens one. */
const FILE_OPEN = '<file name="';

/**
 * The most cache markers Anthropic accepts in one request.
 *
 * Past it the request is refused outright, so a marker that would be
 * one too many is left off: a request without it costs more, and one
 * with it costs the whole turn.
 */
const MOST_BREAKPOINTS = 4;

/**
 * The request, with a cache marker where the shared brief ends.
 *
 * Undefined when there is nothing to do, in the shape pi's
 * `before_provider_request` hook reads as "leave it alone": a request
 * that is not Anthropic's shape, a first message that did not open with
 * a file, a message that is nothing but files (so the brief already
 * ends where pi marks), a request that marks nothing at all (caching is
 * off, and a marker of ours would turn it on), or one with no room for
 * another marker.
 */
export function withBriefBreakpoint(payload: unknown): unknown {
	if (!isRecord(payload) || !Array.isArray(payload.messages)) return undefined;
	const first = payload.messages[0];
	if (!isRecord(first) || first.role !== "user") return undefined;
	if (!Array.isArray(first.content)) return undefined;
	const block = first.content[0];
	if (!isTextBlock(block) || !block.text.startsWith(FILE_OPEN)) {
		return undefined;
	}

	// The last close, not the first: a brief is a diff, and a diff can
	// hold this very text. The message after it is ours, and does not.
	const close = block.text.lastIndexOf(FILE_CLOSE);
	if (close < 0) return undefined;
	const cut = close + FILE_CLOSE.length;
	if (cut >= block.text.length) return undefined;

	const control = block.cache_control ?? firstControl(payload);
	if (control === undefined) return undefined;
	if (countBreakpoints(payload) >= MOST_BREAKPOINTS) return undefined;

	const brief = {
		type: "text",
		text: block.text.slice(0, cut),
		cache_control: control,
	};
	const own = { ...block, text: block.text.slice(cut) };
	const messages = [...payload.messages];
	messages[0] = { ...first, content: [brief, own, ...first.content.slice(1)] };
	return { ...payload, messages };
}

/** A text block, in the shape Anthropic's messages take. */
interface TextBlock {
	type: "text";
	text: string;
	cache_control?: unknown;
}

function isTextBlock(value: unknown): value is TextBlock {
	return (
		isRecord(value) && value.type === "text" && typeof value.text === "string"
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * The marker pi already chose for this request, to use the same one.
 *
 * Copied rather than written, because the marker carries how long the
 * entry lives, and a brief cached for five minutes beside a
 * conversation cached for an hour would expire under it.
 */
function firstControl(payload: Record<string, unknown>): unknown {
	for (const block of blocksOf(payload)) {
		if (block.cache_control !== undefined) return block.cache_control;
	}
	return undefined;
}

/** How many cache markers the request already carries. */
function countBreakpoints(payload: Record<string, unknown>): number {
	let count = 0;
	for (const block of blocksOf(payload)) {
		if (block.cache_control !== undefined) count += 1;
	}
	return count;
}

/** Every place a cache marker can sit: tools, system and message blocks. */
function* blocksOf(
	payload: Record<string, unknown>,
): Generator<Record<string, unknown>> {
	for (const list of [payload.tools, payload.system]) {
		if (!Array.isArray(list)) continue;
		for (const item of list) if (isRecord(item)) yield item;
	}
	if (!Array.isArray(payload.messages)) return;
	for (const message of payload.messages) {
		if (!isRecord(message) || !Array.isArray(message.content)) continue;
		for (const block of message.content) if (isRecord(block)) yield block;
	}
}

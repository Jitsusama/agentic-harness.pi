/**
 * The first head a session sent, kept at the front of every request
 * after a compaction, so the provider's cache of the prompt and tools
 * still answers for it.
 *
 * pi sends a session's prompt and tools once, in the system message that
 * leads its first request, and every later change as a patch further
 * on, so the head the provider cached never moves. A compaction drops
 * the patches with everything else before it and puts the prompt and
 * tools as they stand now into one new head. When anything changed since
 * the session started, a section a reload reworded or a tool a search
 * loaded, that head differs from the cached one, and the provider
 * writes everything from the first difference on again. On 6 November,
 * 114 of the 352 first turns after a compaction across the machine read
 * nothing from cache.
 *
 * Put back, the first head leads again and one patch after it carries
 * what changed, so the model reads the same prompt and tools as pi's
 * fold would give it, and the cached head is read rather than written.
 */

import {
	contentText,
	getCurrentTools,
	getToolStateChanges,
	type SystemMessage,
} from "@earendil-works/pi-ai";

/** What a patch message joins one prompt's content to the next with. */
const CONTENT_JOIN = "\n\n";

/** The first system message on a session's branch, which led its first request. */
export function firstHeadOf(
	entries: readonly { readonly type: string; readonly message?: unknown }[],
): SystemMessage | undefined {
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		if (isSystemMessage(entry.message)) return entry.message;
	}
	return undefined;
}

/**
 * The request's messages with `first` leading them and a patch after it
 * that brings it to the head they had, or nothing when they already
 * start with `first` or the difference can't be said as a patch.
 */
export function keepFirstHead<M extends { readonly role: string }>(
	first: SystemMessage,
	messages: readonly M[],
): (M | SystemMessage)[] | undefined {
	const head = messages[0];
	if (!isSystemMessage(head)) return undefined;
	const patch = patchBetween(first, head);
	if (patch === undefined || patch === SAME) return undefined;
	return [first, patch, ...messages.slice(1)];
}

/** The two heads already say the same thing. */
const SAME = Symbol("same");

/**
 * One system message that, replayed after `from`, gives `to`: content
 * added after it, sections set or removed by name, and tools added or
 * withdrawn. Content that doesn't continue `from`'s can't be patched,
 * since pi joins a later message's content after the first one's.
 */
function patchBetween(
	from: SystemMessage,
	to: SystemMessage,
): SystemMessage | typeof SAME | undefined {
	const content = contentAfter(
		contentText(from.content),
		contentText(to.content),
	);
	if (content === undefined) return undefined;
	const sections = sectionsBetween(from.sections ?? {}, to.sections ?? {});
	const { toolsAdded, toolsRemoved } = getToolStateChanges(
		getCurrentTools([from]),
		getCurrentTools([to]),
	);
	if (
		content === "" &&
		sections === undefined &&
		toolsAdded.length === 0 &&
		toolsRemoved.length === 0
	) {
		return SAME;
	}
	return {
		role: "system",
		content,
		...(sections === undefined ? {} : { sections }),
		...(toolsAdded.length > 0 ? { toolsAdded } : {}),
		...(toolsRemoved.length > 0 ? { toolsRemoved } : {}),
		timestamp: to.timestamp,
	};
}

/** What `to` adds after `from`, or nothing when it doesn't begin with it. */
function contentAfter(from: string, to: string): string | undefined {
	if (to === from) return "";
	if (from === "") return to;
	const lead = `${from}${CONTENT_JOIN}`;
	return to.startsWith(lead) ? to.slice(lead.length) : undefined;
}

/** Sections `to` sets differently from `from`, and those it no longer has. */
function sectionsBetween(
	from: Readonly<Record<string, string | null>>,
	to: Readonly<Record<string, string | null>>,
): Record<string, string | null> | undefined {
	const patch: Record<string, string | null> = {};
	for (const [name, text] of Object.entries(to)) {
		if (text !== null && from[name] !== text) patch[name] = text;
	}
	for (const [name, text] of Object.entries(from)) {
		if (text !== null && (to[name] === undefined || to[name] === null)) {
			patch[name] = null;
		}
	}
	return Object.keys(patch).length > 0 ? patch : undefined;
}

function isSystemMessage(message: unknown): message is SystemMessage {
	return (
		typeof message === "object" &&
		message !== null &&
		"role" in message &&
		message.role === "system"
	);
}

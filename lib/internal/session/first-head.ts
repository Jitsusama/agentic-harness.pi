/**
 * The head a session sent, kept at the front of every request after a
 * compaction, so the provider's cache of the prompt and tools still
 * answers for it.
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
 *
 * The patch grows with a session's age, though, and is written again at
 * every compaction and read on every turn. On 8 November the patch
 * averaged 66,830 characters across 629 compactions, against a head of
 * 148,319, and 106,778 in sessions one to three days old. So once a compaction's head differs from
 * the kept one by a quarter of it, that compaction's head is kept from
 * then on, and is written once.
 */

import {
	contentText,
	getCurrentTools,
	getToolStateChanges,
	type SystemMessage,
} from "@earendil-works/pi-ai";

/** What a patch message joins one prompt's content to the next with. */
const CONTENT_JOIN = "\n\n";

/**
 * The share of the kept head a patch may reach before a compaction's
 * own head is kept instead. Writing a head costs $8 a million tokens and
 * reading one $0.20, so moving costs about 7.8 of the head's size; a
 * patch is written at the compaction and read on each of a cycle's
 * turns, 109 on average on 8 November, so carrying it costs about 29.8
 * of its size. Past a quarter, moving pays within the cycle.
 */
export const MOVE_SHARE = 0.25;

/**
 * The head a session's requests lead with now: its first system
 * message, or the head of the compaction that last moved it there,
 * walked from the branch alone so every request in a cycle agrees.
 */
export function keptHeadOf(
	entries: readonly HeadEntry[],
): SystemMessage | undefined {
	let kept: SystemMessage | undefined;
	for (const entry of entries) kept = keptHeadAfter(kept, entry);
	return kept;
}

/** What a branch's entries are read for, to tell its kept head. */
export interface HeadEntry {
	readonly type: string;
	readonly message?: unknown;
	readonly systemMessage?: unknown;
}

/**
 * The kept head once `entry` follows a branch that kept `kept`: one step
 * of `keptHeadOf`, so a branch that grows can be told from what it
 * gained alone.
 */
export function keptHeadAfter(
	kept: SystemMessage | undefined,
	entry: HeadEntry,
): SystemMessage | undefined {
	if (kept === undefined) {
		return entry.type === "message" && isSystemMessage(entry.message)
			? entry.message
			: undefined;
	}
	if (entry.type !== "compaction" || !isSystemMessage(entry.systemMessage)) {
		return kept;
	}
	return outgrown(kept, entry.systemMessage) ? entry.systemMessage : kept;
}

/** Whether the patch from `kept` to `head` has reached `MOVE_SHARE` of `kept`, or can't be said. */
function outgrown(kept: SystemMessage, head: SystemMessage): boolean {
	const patch = patchBetween(kept, head);
	if (patch === SAME) return false;
	if (patch === undefined) return true;
	return sizeOf(patch) >= MOVE_SHARE * sizeOf(kept);
}

/** A system message's size as sent: its content, its sections and its tools. */
function sizeOf(message: SystemMessage): number {
	let size = contentText(message.content).length;
	for (const text of Object.values(message.sections ?? {})) {
		size += text?.length ?? 0;
	}
	const tools = message.toolsAdded ?? [];
	return tools.length > 0 ? size + JSON.stringify(tools).length : size;
}

/**
 * The request's messages with `kept` leading them and a patch after it
 * that brings it to the head they had, or nothing when they already
 * start with `kept` or the difference can't be said as a patch.
 */
export function keepHead<M extends { readonly role: string }>(
	kept: SystemMessage,
	messages: readonly M[],
): (M | SystemMessage)[] | undefined {
	const head = messages[0];
	if (!isSystemMessage(head)) return undefined;
	const patch = patchFor(kept, head);
	if (patch === undefined || patch === SAME) return undefined;
	return [kept, patch, ...messages.slice(1)];
}

/**
 * The last head each kept head was patched to, and the patch. pi clones
 * the context for every request, so a head comes as a new object equal
 * to the last, and working the patch out again compared every tool's
 * declaration: up to 12.8 s of 5KBYD7's 13-minute soak of twelve pis
 * (85PKB2, 13 November 2026). A kept head is one session's own entry, so keying
 * by it keeps each session's apart.
 */
const lastPatched = new WeakMap<
	SystemMessage,
	{ readonly head: string; readonly patch: Patch }
>();

/** What `patchBetween` answers. */
type Patch = SystemMessage | typeof SAME | undefined;

/** The patch from `kept` to `head`, worked out only when `head` changed. */
function patchFor(kept: SystemMessage, head: SystemMessage): Patch {
	// The whole head as text: pi folds a head under its first message's
	// timestamp, so a tool reworded since leaves no smaller mark, and
	// writing it out costs far less than comparing declarations.
	const print = JSON.stringify(head);
	const last = lastPatched.get(kept);
	if (last !== undefined && last.head === print) return last.patch;
	const patch = patchBetween(kept, head);
	lastPatched.set(kept, { head: print, patch });
	return patch;
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

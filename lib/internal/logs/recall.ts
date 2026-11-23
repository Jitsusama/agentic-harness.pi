/**
 * Search a session's own log, or read one entry of it, so what a
 * compaction dropped from the context stays within reach.
 *
 * A compaction keeps a summary and a recent tail, and everything else
 * leaves the context while staying on disk. Replays of real sessions
 * scored better on questions about the earlier work when the model
 * could search that log than when it could not, whatever the summary
 * said.
 *
 * Search matches word by word, because a model asks in its own words
 * ("the commit trailer we agreed on") and those almost never appear in
 * the log as one phrase. Rarer words count for more, so a distinctive
 * name outranks the everyday words around it. Each hit shows a window
 * around its first match, since whole entries holding tool output are
 * large enough that a page of them would show one.
 *
 * A page is bounded because recall runs after a compaction, into the
 * room the compaction just made: an unbounded answer could put back
 * enough of the old session to trigger the next one.
 *
 * An entry is read by its id, or by a paragraph reference (`p:` and a
 * hash, as the compaction's excerpts name their quotes), which finds
 * the latest entry saying that paragraph. A reference is the words, not
 * the place, so it still reads back after a host rebuilt the log with
 * new ids. An entry read names the entries either side of it, so the
 * model can step through what was said around it.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { refHashPrefix, unitsOf } from "../../compaction/selection/units.ts";
import { isRecord } from "../record.ts";

/** The tool's name, which the summary's note and the tool share. */
export const RECALL_TOOL = "session_recall";

/** Most hits on one page. */
export const PAGE_HITS = 10;

/** Most characters on one page, about 4k tokens at four a token. */
export const PAGE_CHARS = 16_000;

/** Characters of an entry a hit shows around its first match. */
export const SNIPPET_CHARS = 900;

/** One entry of the log as text, under the id that reads it back. */
export interface EntryText {
	readonly id: string;
	readonly text: string;
}

/** One entry that matched a search, and how well. */
export interface Hit {
	readonly id: string;
	readonly score: number;
	/** The window of the entry around its first match. */
	readonly snippet: string;
}

/** What one recall produced: a page to show and everything behind it. */
export type Recalled =
	| {
			readonly kind: "hits";
			/** The rendered page. */
			readonly view: string;
			/** Every hit, the page's and the rest. */
			readonly hits: readonly Hit[];
			/** What follows the page, when hits are left over. */
			readonly more?: string;
	  }
	| {
			readonly kind: "entry";
			readonly view: string;
			readonly entry: EntryText;
			/** Whether the view cut the entry short. */
			readonly cut: boolean;
	  }
	| { readonly kind: "none"; readonly view: string };

/** What the model asked for. */
export interface RecallRequest {
	readonly query?: string;
	readonly entryId?: string;
	/** 1-based page of hits. */
	readonly page?: number;
}

function textOfParts(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const texts: string[] = [];
	for (const part of content) {
		if (isRecord(part) && part.type === "text" && typeof part.text === "string")
			texts.push(part.text);
	}
	return texts.join("\n");
}

interface ToolCallPart {
	readonly type: "toolCall";
	readonly id: string;
	readonly name: string;
	readonly arguments: unknown;
}

function isToolCall(part: unknown): part is ToolCallPart {
	return isRecord(part) && part.type === "toolCall";
}

/** A tool call an entry makes, and whether it is recall's own. */
export interface CallMade {
	readonly id: string;
	readonly recalls: boolean;
}

/** The tool calls an assistant entry makes, in order. */
export function callsIn(entry: SessionEntry): CallMade[] {
	if (entry.type !== "message") return [];
	const message: unknown = entry.message;
	if (!isRecord(message) || message.role !== "assistant") return [];
	if (!Array.isArray(message.content)) return [];
	const calls: CallMade[] = [];
	for (const part of message.content) {
		if (isToolCall(part) && typeof part.id === "string")
			calls.push({ id: part.id, recalls: part.name === RECALL_TOOL });
	}
	return calls;
}

/** What a tool result entry answers, and its text. */
export interface ResultGiven {
	readonly callId: string;
	readonly text: string;
}

/** The call a tool result entry answers and what it said, if it is one. */
export function resultOf(entry: SessionEntry): ResultGiven | undefined {
	if (entry.type !== "message") return undefined;
	const message: unknown = entry.message;
	if (!isRecord(message) || message.role !== "toolResult") return undefined;
	if (typeof message.toolCallId !== "string") return undefined;
	return { callId: message.toolCallId, text: textOfParts(message.content) };
}

/**
 * The log as text, one item per entry that says something.
 *
 * A tool call is read together with its result, under the assistant
 * entry that made it, because the call says what was asked and the
 * result what came back, and either alone answers half a question.
 * Recall's own calls are left out: searching them would find every
 * earlier search's hits a second time.
 */
export function entryTexts(entries: readonly SessionEntry[]): EntryText[] {
	const { results, recallCalls } = callsAcross(entries);
	const texts: EntryText[] = [];
	for (const entry of entries) {
		const text = entryText(entry, results, recallCalls);
		if (text.trim() !== "") texts.push({ id: entry.id, text });
	}
	return texts;
}

/** Every tool result `entries` hold, by call, and recall's own calls. */
function callsAcross(entries: readonly SessionEntry[]): {
	results: Map<string, string>;
	recallCalls: Set<string>;
} {
	const results = new Map<string, string>();
	const recallCalls = new Set<string>();
	for (const entry of entries) {
		for (const call of callsIn(entry)) {
			if (call.recalls) recallCalls.add(call.id);
		}
		const given = resultOf(entry);
		if (given) results.set(given.callId, given.text);
	}
	return { results, recallCalls };
}

/**
 * One entry as text: its calls read with their `results`, recall's own
 * calls left out, and an empty text for an entry that says nothing.
 */
export function entryText(
	entry: SessionEntry,
	results: ReadonlyMap<string, string>,
	recallCalls: ReadonlySet<string>,
): string {
	switch (entry.type) {
		case "message":
			return messageText(entry.message, results, recallCalls);
		case "compaction":
		case "branch_summary":
			return typeof entry.summary === "string" ? entry.summary : "";
		case "custom_message":
			return textOfParts(entry.content);
		default:
			return "";
	}
}

function messageText(
	message: unknown,
	results: ReadonlyMap<string, string>,
	recallCalls: ReadonlySet<string>,
): string {
	if (!isRecord(message)) return "";
	const m = message;
	switch (m.role) {
		case "user":
			return textOfParts(m.content);
		case "assistant": {
			if (!Array.isArray(m.content)) return "";
			const parts: string[] = [];
			for (const part of m.content) {
				if (!isRecord(part)) continue;
				if (part.type === "text" && typeof part.text === "string") {
					parts.push(part.text);
				} else if (isToolCall(part) && !recallCalls.has(part.id)) {
					parts.push(`${plain(part.name)} ${JSON.stringify(part.arguments)}`);
					const result = results.get(part.id);
					if (result) parts.push(result);
				}
			}
			return parts.join("\n");
		}
		case "toolResult":
			// Read with the call that asked for it, under the assistant
			// entry; standing alone it would be every hit twice.
			return "";
		case "bashExecution":
			return `${plain(m.command)}\n${plain(m.output)}`;
		default:
			return "";
	}
}

/**
 * A field as text when it is a plain value, and nothing otherwise: an
 * object a log line forged could throw on being made a string.
 */
function plain(value: unknown): string {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	return "";
}

/** The distinct words of a query, lowercased. */
function wordsOf(query: string): string[] {
	return [
		...new Set(
			query
				.toLowerCase()
				.split(/\s+/)
				.filter((word) => word !== ""),
		),
	];
}

/**
 * What one request looks for, worked out once so every entry, in memory
 * or read from disk, is marked against the same thing.
 */
export interface Asked {
	/** The query's distinct words, lowercased; none when reading by id. */
	readonly words: readonly string[];
	/** The id or reference asked to be read. */
	readonly entryId?: string;
	/** The hash prefix, when `entryId` is a paragraph reference. */
	readonly prefix?: string;
}

/** What `request` looks for. */
export function askedBy(request: RecallRequest): Asked {
	const entryId = request.entryId?.trim();
	if (entryId) {
		const prefix = refHashPrefix(entryId);
		return { words: [], entryId, ...(prefix ? { prefix } : {}) };
	}
	return { words: wordsOf(request.query?.trim() ?? "") };
}

/**
 * One entry as a search needs it: what it holds of a request, and
 * text only where the answer could show it, so a reader can mark a
 * whole log and keep a few snippets rather than every entry's text.
 */
export interface Marked {
	readonly id: string;
	/** Whether it says anything, which is what a search ranks among. */
	readonly said: boolean;
	/** The indexes of the query's words it holds, in order. */
	readonly holds: readonly number[];
	/** Whether it says the paragraph a reference names. */
	readonly named: boolean;
	/** Its whole text, when it is the entry asked for by id or reference. */
	readonly text?: string;
	/** The window a hit shows, when it holds a word. */
	readonly snippet?: string;
}

/** Whether `entry` says the paragraph the reference in `asked` names. */
export function namedBy(entry: SessionEntry, asked: Asked): boolean {
	const { prefix } = asked;
	if (prefix === undefined || !spokenShape(entry)) return false;
	return unitsOf(entry).some((unit) => unit.hash.startsWith(prefix));
}

/**
 * Whether `entry` has the shape `unitsOf` reads: a log can hold a line
 * that parses but that pi never wrote, and such a line names no
 * paragraph rather than failing the recall.
 */
function spokenShape(entry: SessionEntry): boolean {
	if (entry.type !== "message") return true;
	const message: unknown = entry.message;
	if (!isRecord(message)) return false;
	const { role, content } = message;
	if (role !== "user" && role !== "assistant") return true;
	if (role === "user" && typeof content === "string") return true;
	return Array.isArray(content) && content.every(spokenPart);
}

/** Whether a content part is one `unitsOf` can read: a text part's text is a string. */
function spokenPart(part: unknown): boolean {
	return (
		isRecord(part) && (part.type !== "text" || typeof part.text === "string")
	);
}

/** Mark one entry, given its text, against `asked`. */
export function markOf(
	id: string,
	text: string,
	asked: Asked,
	named = false,
): Marked {
	const said = text.trim() !== "";
	const lowered = said && asked.words.length > 0 ? text.toLowerCase() : "";
	const holds: number[] = [];
	asked.words.forEach((word, w) => {
		if (said && lowered.includes(word)) holds.push(w);
	});
	return {
		id,
		said,
		holds,
		named,
		...(said && (named || id === asked.entryId) ? { text } : {}),
		...(holds.length > 0
			? { snippet: snippetOf(text, lowered, asked.words) }
			: {}),
	};
}

/** Mark every entry of `entries`, their calls read with their results. */
export function markEntries(
	entries: readonly SessionEntry[],
	asked: Asked,
): Marked[] {
	const { results, recallCalls } = callsAcross(entries);
	return entries.map((entry) =>
		markOf(
			entry.id,
			entryText(entry, results, recallCalls),
			asked,
			namedBy(entry, asked),
		),
	);
}

/**
 * Every entry that holds any of the query's words, best first.
 *
 * An entry scores the sum, over the words it holds, of how rare each
 * word is across the log. Entries that score the same keep the log's
 * order.
 */
export function search(texts: readonly EntryText[], query: string): Hit[] {
	const asked = { words: wordsOf(query) };
	return hitsOf(
		texts.map((entry) => markOf(entry.id, entry.text, asked)),
		asked.words,
	);
}

function hitsOf(marked: readonly Marked[], words: readonly string[]): Hit[] {
	if (words.length === 0) return [];
	const texts = marked.filter((mark) => mark.said);
	const rarity = words.map((_, w) => {
		const holding = texts.filter((mark) => mark.holds.includes(w)).length;
		return holding === 0 ? 0 : Math.log(1 + texts.length / holding);
	});

	const hits: Hit[] = [];
	for (const mark of texts) {
		let score = 0;
		for (const w of mark.holds) score += rarity[w] ?? 0;
		if (score > 0) {
			hits.push({ id: mark.id, score, snippet: mark.snippet ?? "" });
		}
	}
	// Array.prototype.sort is stable, which is what keeps ties in order.
	return hits.sort((a, b) => b.score - a.score);
}

function snippetOf(
	text: string,
	lowered: string,
	words: readonly string[],
): string {
	if (text.length <= SNIPPET_CHARS) return text;
	const first = Math.min(
		...words.map((word) => lowered.indexOf(word)).filter((at) => at >= 0),
	);
	const start = Math.max(0, first - SNIPPET_CHARS / 2);
	const end = Math.min(text.length, start + SNIPPET_CHARS);
	const before = start > 0 ? "... " : "";
	const after = end < text.length ? " ..." : "";
	return `${before}${text.slice(start, end)}${after}`;
}

function rendered(hit: Hit): string {
	return `[${hit.id}] ${hit.snippet}`;
}

/** Split the hits into pages, each within the hit and character caps. */
function paginate(hits: readonly Hit[]): Hit[][] {
	const pages: Hit[][] = [];
	let page: Hit[] = [];
	let chars = 0;
	for (const hit of hits) {
		const size = rendered(hit).length;
		const full = page.length >= PAGE_HITS || chars + size > PAGE_CHARS;
		if (full && page.length > 0) {
			pages.push(page);
			page = [];
			chars = 0;
		}
		page.push(hit);
		chars += size;
	}
	if (page.length > 0) pages.push(page);
	return pages;
}

/**
 * Answer one recall: a page of hits for a query, or one entry by id.
 *
 * Pure, so the tool can bound and store what this returns and the
 * tests can read it without a session.
 */
export function recall(
	entries: readonly SessionEntry[],
	request: RecallRequest,
): Recalled {
	const asked = askedBy(request);
	return answer(markEntries(entries, asked), request, asked);
}

/**
 * Answer one recall from entries already marked against it, in log
 * order: what `recall` answers for the entries they were marked from.
 */
export function answer(
	marked: readonly Marked[],
	request: RecallRequest,
	asked: Asked = askedBy(request),
): Recalled {
	if (asked.entryId) {
		if (asked.prefix) return readByRef(marked, asked.entryId);
		return readOne(marked, asked.entryId);
	}

	const query = request.query?.trim() ?? "";
	if (query === "") {
		return {
			kind: "none",
			view:
				"Give a query to search this session's log, or an entryId to " +
				"read one entry of it.",
		};
	}
	const hits = hitsOf(marked, asked.words);
	if (hits.length === 0) {
		return {
			kind: "none",
			view: `No entry in this session's log matches "${query}".`,
		};
	}

	const pages = paginate(hits);
	const number = Math.max(1, Math.floor(request.page ?? 1));
	const page = pages[number - 1];
	if (!page) {
		return {
			kind: "none",
			view:
				`There is no page ${number}: ${hits.length} entries match, ` +
				`over ${pages.length} ${pages.length === 1 ? "page" : "pages"}.`,
		};
	}
	const after = pages.slice(number).flat();
	// The ids named are the next page's alone. This line is a trailer,
	// kept whole past the page budget, and naming every later hit made
	// a common word's search answer 220 KB of ids; the rest are in the
	// stored hits.
	const named = after.slice(0, PAGE_HITS).map((h) => h.id);
	const unnamed = after.length - named.length;
	return {
		kind: "hits",
		view: page.map(rendered).join("\n\n"),
		hits,
		...(after.length === 0
			? {}
			: {
					more:
						`${after.length} more matching ${after.length === 1 ? "entry" : "entries"} ` +
						`not shown. Read one by entryId (${named.join(" ")}${unnamed > 0 ? `, and ${unnamed} more in the stored hits` : ""}), ` +
						`narrow the query, or ask for page ${number + 1}.`,
				}),
	};
}

/** The latest entry saying the paragraph a reference names. */
function readByRef(marked: readonly Marked[], ref: string): Recalled {
	for (let at = marked.length - 1; at >= 0; at--) {
		const mark = marked[at];
		if (mark?.named) return readOne(marked, mark.id, ref);
	}
	return {
		kind: "none",
		view:
			`No entry in this session's log says the paragraph ${ref}. ` +
			"Search for its words instead.",
	};
}

function readOne(
	marked: readonly Marked[],
	id: string,
	ref?: string,
): Recalled {
	const texts = marked.filter((mark) => mark.said);
	const at = texts.findIndex((t) => t.id === id);
	const found = texts[at];
	const entry =
		found?.text === undefined ? undefined : { id: found.id, text: found.text };
	if (!entry) {
		return {
			kind: "none",
			view:
				`No entry in this session's log has id ${id}. ` +
				"If the log was rebuilt since that id was given, the ids have " +
				"changed: search for the words instead.",
		};
	}
	const cut = entry.text.length > PAGE_CHARS;
	const shown = cut ? entry.text.slice(0, PAGE_CHARS) : entry.text;
	const before = texts[at - 1]?.id;
	const after = texts[at + 1]?.id;
	const around = [
		...(before ? [`Before it: ${before}.`] : []),
		...(after ? [`After it: ${after}.`] : []),
	].join(" ");
	return {
		kind: "entry",
		view: `[${entry.id}]${ref ? ` (${ref})` : ""} ${shown}${around ? `\n\n${around}` : ""}`,
		entry,
		cut,
	};
}

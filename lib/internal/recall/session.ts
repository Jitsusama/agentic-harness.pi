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
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

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

interface TextPart {
	readonly type: string;
	readonly text?: string;
}

function textOfParts(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return (content as TextPart[])
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

interface ToolCallPart {
	readonly type: "toolCall";
	readonly id: string;
	readonly name: string;
	readonly arguments: unknown;
}

function isToolCall(part: unknown): part is ToolCallPart {
	return (
		typeof part === "object" &&
		part !== null &&
		(part as { type?: unknown }).type === "toolCall"
	);
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
	const results = new Map<string, string>();
	const recallCalls = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message as { role?: string; content?: unknown };
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const part of message.content) {
				if (isToolCall(part) && part.name === RECALL_TOOL) {
					recallCalls.add(part.id);
				}
			}
		}
		if (message.role === "toolResult") {
			const result = entry.message as { toolCallId?: unknown };
			if (typeof result.toolCallId === "string") {
				results.set(result.toolCallId, textOfParts(message.content));
			}
		}
	}

	const texts: EntryText[] = [];
	for (const entry of entries) {
		const text = textOf(entry, results, recallCalls);
		if (text.trim() !== "") texts.push({ id: entry.id, text });
	}
	return texts;
}

function textOf(
	entry: SessionEntry,
	results: ReadonlyMap<string, string>,
	recallCalls: ReadonlySet<string>,
): string {
	switch (entry.type) {
		case "message":
			return messageText(entry.message, results, recallCalls);
		case "compaction":
		case "branch_summary":
			return entry.summary;
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
	const m = message as {
		role?: string;
		content?: unknown;
		command?: unknown;
		output?: unknown;
		toolCallId?: unknown;
	};
	switch (m.role) {
		case "user":
			return textOfParts(m.content);
		case "assistant": {
			if (!Array.isArray(m.content)) return "";
			const parts: string[] = [];
			for (const part of m.content as unknown[]) {
				const text = part as TextPart;
				if (text.type === "text" && typeof text.text === "string") {
					parts.push(text.text);
				} else if (isToolCall(part) && !recallCalls.has(part.id)) {
					parts.push(`${part.name} ${JSON.stringify(part.arguments)}`);
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
			return `${String(m.command ?? "")}\n${String(m.output ?? "")}`;
		default:
			return "";
	}
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
 * Every entry that holds any of the query's words, best first.
 *
 * An entry scores the sum, over the words it holds, of how rare each
 * word is across the log. Entries that score the same keep the log's
 * order.
 */
export function search(texts: readonly EntryText[], query: string): Hit[] {
	const words = wordsOf(query);
	if (words.length === 0) return [];
	const lowered = texts.map((t) => t.text.toLowerCase());
	const rarity = words.map((word) => {
		const holding = lowered.filter((text) => text.includes(word)).length;
		return holding === 0 ? 0 : Math.log(1 + texts.length / holding);
	});

	const hits: Hit[] = [];
	texts.forEach((entry, i) => {
		const text = lowered[i] ?? "";
		let score = 0;
		words.forEach((word, w) => {
			if (text.includes(word)) score += rarity[w] ?? 0;
		});
		if (score > 0) {
			hits.push({
				id: entry.id,
				score,
				snippet: snippetOf(entry.text, text, words),
			});
		}
	});
	// Array.prototype.sort is stable, which is what keeps ties in order.
	return hits.sort((a, b) => b.score - a.score);
}

function snippetOf(text: string, lowered: string, words: string[]): string {
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
	const texts = entryTexts(entries);
	const entryId = request.entryId?.trim();
	if (entryId) return readOne(texts, entryId);

	const query = request.query?.trim() ?? "";
	if (query === "") {
		return {
			kind: "none",
			view:
				"Give a query to search this session's log, or an entryId to " +
				"read one entry of it.",
		};
	}
	const hits = search(texts, query);
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
	return {
		kind: "hits",
		view: page.map(rendered).join("\n\n"),
		hits,
		...(after.length === 0
			? {}
			: {
					more:
						`${after.length} more matching ${after.length === 1 ? "entry" : "entries"} ` +
						`not shown. Read one by entryId (${after.map((h) => h.id).join(" ")}), ` +
						`narrow the query, or ask for page ${number + 1}.`,
				}),
	};
}

function readOne(texts: readonly EntryText[], id: string): Recalled {
	const entry = texts.find((t) => t.id === id);
	if (!entry) {
		return {
			kind: "none",
			view: `No entry in this session's log has id ${id}.`,
		};
	}
	const cut = entry.text.length > PAGE_CHARS;
	const shown = cut ? entry.text.slice(0, PAGE_CHARS) : entry.text;
	return {
		kind: "entry",
		view: `[${entry.id}] ${shown}`,
		entry,
		cut,
	};
}

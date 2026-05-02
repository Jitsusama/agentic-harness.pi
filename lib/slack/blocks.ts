/**
 * Block Kit support: tokenising mrkdwn into rich text
 * elements, building structured `rich_text` blocks (lists,
 * quotes, code blocks, tables) for sending, rendering
 * received rich text back to readable text and extracting
 * tables from blocks.
 */

import { displayNameForId } from "./resolvers/user.js";
import type { SlackColumnSetting, SlackTable } from "./types.js";

// ── Rich text element types ─────────────────────────────

/** A Block Kit inline element within a rich_text_section. */
interface RichTextElement {
	type: string;
	text?: string;
	url?: string;
	style?: {
		bold?: boolean;
		italic?: boolean;
		strike?: boolean;
		code?: boolean;
	};
	user_id?: string;
	channel_id?: string;
	range?: string;
	name?: string;
}

// ── mrkdwn → Block Kit elements (sending) ───────────────

/**
 * Characters that signal potential mrkdwn formatting.
 *
 * Used as a fast pre-check: if a string contains none of
 * these, it's plain text and can skip tokenising.
 */
const FORMATTING_CHARS = /[<`*_~:[#]/;

/**
 * Angle-bracket pattern: matches Slack's `<...>` syntax for
 * links, mentions, channels and broadcasts.
 */
const ANGLE_BRACKET = /<([^>]+)>/g;

/**
 * Backtick pattern: matches inline code spans.
 */
const BACKTICK = /`([^`]+)`/g;

/**
 * Markdown-style link pattern: `[text](url)`. Many agents
 * (and humans copy-pasting from anywhere) write links this
 * way instead of Slack's native `<url|text>` syntax. Without
 * conversion they render as literal brackets and parens.
 */
const MARKDOWN_LINK = /\[([^\]\n]+)\]\(([^)\s]+)\)/g;

/**
 * Inline style patterns with word-boundary rules.
 *
 * Opening marker must be preceded by whitespace or
 * start-of-string. Closing marker must be followed by
 * whitespace, punctuation, or end-of-string. Content
 * between markers must be non-empty and not contain the
 * marker character.
 */
const BOLD = /(^|(?<=\s))\*([^*]+)\*(?=\s|[.,;:!?)}\]]|$)/g;
const ITALIC = /(^|(?<=\s))_([^_]+)_(?=\s|[.,;:!?)}\]]|$)/g;
const STRIKE = /(^|(?<=\s))~([^~]+)~(?=\s|[.,;:!?)}\]]|$)/g;

/**
 * Markdown-style double-marker patterns. Agents reflexively
 * write `**bold**` and `~~strike~~` even when targeting
 * Slack mrkdwn, where those would render with the marker
 * characters visible. We accept them as alternatives.
 */
const MARKDOWN_BOLD = /\*\*([^*\n]+?)\*\*/g;
const MARKDOWN_STRIKE = /~~([^~\n]+?)~~/g;

/**
 * Emoji shortcode pattern: `:name:` where name can contain
 * letters, numbers, underscores, hyphens and plus signs.
 */
const EMOJI = /:([a-z0-9_+-]+):/g;

/**
 * Hex-colour-lookalike pattern: `#` followed by 3, 4, 6 or
 * 8 hex digits with no alphanumeric character after. Slack
 * auto-renders these as colour swatches in plain mrkdwn,
 * which catches PR numbers like `#675891` (six digits = a
 * valid hex code). Splitting the `#` from the digits across
 * two adjacent text elements defeats the swatch detector
 * while rendering identically.
 */
const HEX_COLOR_LIKE =
	/#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![0-9a-zA-Z])/g;

/** A token found during mrkdwn scanning. */
interface Token {
	/** Start index in the original string. */
	start: number;
	/** End index (exclusive). */
	end: number;
	/**
	 * The Block Kit elements this token produces. Most tokens
	 * yield a single element; the colour-swatch shield emits
	 * two so Slack's auto-detector can't see a single hex run.
	 */
	elements: RichTextElement[];
}

/**
 * Parse an angle-bracket expression into a Block Kit element.
 *
 * Handles user mentions, broadcasts, channel links, and URL
 * links — all of which use Slack's `<...>` internal format.
 */
function parseAngleBracket(content: string): RichTextElement {
	// User mention: <@U123> or <@U123|display.name>
	if (content.startsWith("@")) {
		const pipeIdx = content.indexOf("|");
		const userId = pipeIdx > 0 ? content.slice(1, pipeIdx) : content.slice(1);
		return { type: "user", user_id: userId };
	}

	// Broadcast: <!here>, <!channel>, <!everyone>
	if (content.startsWith("!")) {
		const pipeIdx = content.indexOf("|");
		const range = pipeIdx > 0 ? content.slice(1, pipeIdx) : content.slice(1);
		return { type: "broadcast", range };
	}

	// Channel link: <#C123> or <#C123|channel-name>
	if (content.startsWith("#")) {
		const pipeIdx = content.indexOf("|");
		const channelId =
			pipeIdx > 0 ? content.slice(1, pipeIdx) : content.slice(1);
		return { type: "channel", channel_id: channelId };
	}

	// URL link: <url|text> or <url>
	const pipeIdx = content.indexOf("|");
	if (pipeIdx > 0) {
		return {
			type: "link",
			url: content.slice(0, pipeIdx),
			text: content.slice(pipeIdx + 1),
		};
	}
	return { type: "link", url: content };
}

/**
 * Tokenise a mrkdwn string into Block Kit inline elements.
 *
 * Scans left to right, matching patterns in priority order:
 * angle brackets (unambiguous), backticks, then inline
 * styles with word-boundary rules. Plain text between
 * patterns becomes `text` elements. Adjacent plain segments
 * are merged.
 */
export function parseMrkdwnToElements(text: string): RichTextElement[] {
	if (!text) return [];

	// Collect all tokens from all pattern types.
	const tokens: Token[] = [];

	// 1. Angle-bracket patterns (highest priority — unambiguous
	//    Slack-internal syntax).
	for (const match of text.matchAll(ANGLE_BRACKET)) {
		tokens.push({
			start: match.index,
			end: match.index + match[0].length,
			elements: [parseAngleBracket(match[1])],
		});
	}

	// 2. Markdown-style links. Higher priority than backticks
	//    so a link's display text can contain backticks.
	for (const match of text.matchAll(MARKDOWN_LINK)) {
		tokens.push({
			start: match.index,
			end: match.index + match[0].length,
			elements: [{ type: "link", url: match[2], text: match[1] }],
		});
	}

	// 3. Backtick code spans.
	for (const match of text.matchAll(BACKTICK)) {
		tokens.push({
			start: match.index,
			end: match.index + match[0].length,
			elements: [{ type: "text", text: match[1], style: { code: true } }],
		});
	}

	// 4. Emoji shortcodes.
	for (const match of text.matchAll(EMOJI)) {
		tokens.push({
			start: match.index,
			end: match.index + match[0].length,
			elements: [{ type: "emoji", name: match[1] }],
		});
	}

	// 5. Markdown-style double-marker styles. Must precede
	//    the single-marker patterns so `**bold**` doesn't get
	//    mis-tokenised as `*` then `bold` then `*`.
	for (const match of text.matchAll(MARKDOWN_BOLD)) {
		tokens.push({
			start: match.index,
			end: match.index + match[0].length,
			elements: [{ type: "text", text: match[1], style: { bold: true } }],
		});
	}
	for (const match of text.matchAll(MARKDOWN_STRIKE)) {
		tokens.push({
			start: match.index,
			end: match.index + match[0].length,
			elements: [{ type: "text", text: match[1], style: { strike: true } }],
		});
	}

	// 6. Slack-native single-marker inline styles.
	for (const match of text.matchAll(BOLD)) {
		tokens.push({
			start: match.index,
			end: match.index + match[0].length,
			elements: [{ type: "text", text: match[2], style: { bold: true } }],
		});
	}
	for (const match of text.matchAll(ITALIC)) {
		tokens.push({
			start: match.index,
			end: match.index + match[0].length,
			elements: [{ type: "text", text: match[2], style: { italic: true } }],
		});
	}
	for (const match of text.matchAll(STRIKE)) {
		tokens.push({
			start: match.index,
			end: match.index + match[0].length,
			elements: [{ type: "text", text: match[2], style: { strike: true } }],
		});
	}

	// 7. Hex-colour-lookalike shield (lowest priority — only
	//    fires when no other pattern claims the range). Emits
	//    two adjacent text elements so the rendered output is
	//    identical but Slack's swatch detector sees two pieces
	//    instead of one hex run.
	for (const match of text.matchAll(HEX_COLOR_LIKE)) {
		tokens.push({
			start: match.index,
			end: match.index + match[0].length,
			elements: [
				{ type: "text", text: "#" },
				{ type: "text", text: match[1] },
			],
		});
	}

	// Sort by start position. For overlaps, higher-priority
	// tokens (earlier in the list) take precedence since we
	// skip tokens that overlap with already-consumed ranges.
	tokens.sort((a, b) => a.start - b.start);

	// Walk the string, emitting elements for tokens and
	// plain text for gaps.
	const elements: RichTextElement[] = [];
	let cursor = 0;

	for (const token of tokens) {
		// Skip tokens that overlap with already-consumed text.
		if (token.start < cursor) continue;

		// Emit plain text before this token.
		if (token.start > cursor) {
			const plain = text.slice(cursor, token.start);
			if (plain) pushText(elements, plain);
		}

		for (const el of token.elements) elements.push(el);
		cursor = token.end;
	}

	// Emit any trailing plain text.
	if (cursor < text.length) {
		const plain = text.slice(cursor);
		if (plain) pushText(elements, plain);
	}

	return elements;
}

/**
 * Append a plain text element, merging with the previous
 * element if it's also unstyled plain text.
 */
function pushText(elements: RichTextElement[], text: string): void {
	const last = elements[elements.length - 1];
	if (last?.type === "text" && !last.style) {
		last.text = (last.text ?? "") + text;
	} else {
		elements.push({ type: "text", text });
	}
}

/** Zero-width space used for empty cells (Slack rejects empty text). */
const ZERO_WIDTH_SPACE = "\u200B";

/**
 * Convert a mrkdwn string to a Block Kit table cell.
 *
 * Returns `raw_text` for plain strings (the common case)
 * and `rich_text` for strings with formatting. Empty strings
 * become `raw_text` with a zero-width space.
 */
export function mrkdwnToCell(text: string): unknown {
	if (!text) {
		return { type: "raw_text", text: ZERO_WIDTH_SPACE };
	}

	// Fast path: no formatting characters → raw_text.
	if (!FORMATTING_CHARS.test(text)) {
		return { type: "raw_text", text };
	}

	const elements = parseMrkdwnToElements(text);

	// If parsing produced a single unstyled text element,
	// the formatting characters were false positives (e.g.
	// "a < b"). Use raw_text.
	if (
		elements.length === 1 &&
		elements[0].type === "text" &&
		!elements[0].style
	) {
		return { type: "raw_text", text };
	}

	// Wrap in rich_text cell structure.
	return {
		type: "rich_text",
		elements: [
			{
				type: "rich_text_section",
				elements,
			},
		],
	};
}

// ── Block Kit elements → readable text (reading) ────────

/**
 * Render a single rich text inline element to readable text.
 *
 * Follows the same output conventions as `formatSlackText`
 * in renderers/message.ts: bold → `**text**`, links →
 * `[text](url)`, user mentions → `@handle`, etc.
 */
function renderElement(el: RichTextElement): string {
	switch (el.type) {
		case "text": {
			let result = el.text ?? "";
			if (el.style?.code) result = `\`${result}\``;
			if (el.style?.strike) result = `~${result}~`;
			if (el.style?.italic) result = `_${result}_`;
			if (el.style?.bold) result = `**${result}**`;
			return result;
		}

		case "link": {
			const display = el.text || el.url || "";
			const url = el.url || "";
			return display && display !== url ? `[${display}](${url})` : url;
		}

		case "user": {
			const id = el.user_id ?? "";
			const name = displayNameForId(id);
			return `@${name}`;
		}

		case "channel": {
			const id = el.channel_id ?? "";
			const name = displayNameForId(id);
			return `#${name}`;
		}

		case "broadcast":
			return `@${el.range ?? "here"}`;

		case "emoji":
			return `:${el.name ?? ""}:`;

		default:
			return "";
	}
}

/**
 * Render a `rich_text` table cell to readable text.
 *
 * Walks the cell's elements → rich_text_section → inline
 * elements, converting each to text.
 */
export function renderRichTextCell(cell: unknown): string {
	const typed = cell as {
		type?: string;
		elements?: Array<{
			type?: string;
			elements?: RichTextElement[];
		}>;
	};

	if (typed.type !== "rich_text" || !Array.isArray(typed.elements)) {
		return "";
	}

	const parts: string[] = [];
	for (const section of typed.elements) {
		if (!Array.isArray(section.elements)) continue;
		for (const el of section.elements) {
			parts.push(renderElement(el));
		}
	}
	return parts.join("");
}

// ── Table extraction (reading) ──────────────────────────

/**
 * Extract the text content from a single table cell.
 *
 * Handles both `raw_text` (returns `.text` directly) and
 * `rich_text` (renders inline elements to readable text).
 */
export function extractCellText(cell: unknown): string {
	const typed = cell as { type?: string; text?: string };
	if (typed.type === "raw_text") {
		return typed.text ?? "";
	}
	if (typed.type === "rich_text") {
		return renderRichTextCell(cell);
	}
	return "";
}

/**
 * Extract tables from a raw Block Kit blocks array.
 *
 * Finds all blocks with `type === "table"`, extracts
 * headers, rows, and column settings from each.
 */
export function extractTables(blocks: unknown[]): SlackTable[] {
	const tables: SlackTable[] = [];

	for (const block of blocks) {
		const typed = block as {
			type?: string;
			rows?: unknown[][];
			column_settings?: Array<{
				align?: string;
				is_wrapped?: boolean;
			} | null>;
		};

		if (typed.type !== "table" || !Array.isArray(typed.rows)) continue;
		if (typed.rows.length === 0) continue;

		// First row is the header.
		const headerRow = typed.rows[0];
		const columns = Array.isArray(headerRow)
			? headerRow.map(extractCellText)
			: [];

		// Remaining rows are data.
		const rows = typed.rows
			.slice(1)
			.map((row) => (Array.isArray(row) ? row.map(extractCellText) : []));

		// Column settings.
		let columnSettings: (SlackColumnSetting | null)[] | undefined;
		if (Array.isArray(typed.column_settings)) {
			columnSettings = typed.column_settings.map((s) => {
				if (s == null) return null;
				const setting: SlackColumnSetting = {};
				if (s.align === "left" || s.align === "center" || s.align === "right") {
					setting.align = s.align;
				}
				if (typeof s.is_wrapped === "boolean") {
					setting.isWrapped = s.is_wrapped;
				}
				return Object.keys(setting).length > 0 ? setting : null;
			});
		}

		tables.push({ columns, rows, columnSettings });
	}

	return tables;
}

// ── mrkdwn → rich_text block (sending) ──────────────────

/**
 * Match an ordered list line: `1. content`. Captures
 * leading whitespace, the digits and the content.
 */
const ORDERED_LIST_LINE = /^(\s*)(\d+)\.\s+(.+)$/;

/**
 * Match an unordered list line: `- content`, `* content`
 * or `+ content`. Captures leading whitespace and the
 * content (the marker itself is discarded).
 */
const UNORDERED_LIST_LINE = /^(\s*)[-*+]\s+(.+)$/;

/**
 * Match a blockquote line: `> content`. The space after
 * `>` is optional. Captures the content.
 */
const QUOTE_LINE = /^>\s?(.*)$/;

/**
 * Match a code-fence line: opening or closing triple
 * backticks. Anything after the fence (e.g. a language
 * hint) is ignored — Slack does not render it.
 */
const FENCE_LINE = /^```/;

/**
 * Match a heading line: one to six leading `#` followed by
 * whitespace and content. Slack only has a single `header`
 * block style, so the level is captured for completeness
 * but not used — `#` and `######` render the same.
 */
const HEADING_LINE = /^(#{1,6})\s+(.+)$/;

/**
 * Match a divider line: three or more dashes, asterisks or
 * underscores on a line by themselves. Mirrors CommonMark's
 * thematic-break rule. Distinct from a list bullet because
 * a bullet always has whitespace and content after the
 * marker.
 */
const DIVIDER_LINE = /^(?:-{3,}|\*{3,}|_{3,})\s*$/;

/**
 * Width of one indent level for nested lists, measured in
 * spaces. Two spaces or one tab counts as one level — the
 * convention Slack's editor uses.
 */
const INDENT_WIDTH = 2;

/** Maximum nesting level Slack accepts for `rich_text_list`. */
const MAX_LIST_INDENT = 8;

/**
 * Compute an indent level from a run of leading whitespace.
 *
 * Tabs count as one full level; spaces count as one level
 * per `INDENT_WIDTH` characters. The result is clamped so
 * we never exceed Slack's nesting limit.
 */
function indentLevel(whitespace: string): number {
	let spaces = 0;
	for (const ch of whitespace) {
		if (ch === "\t") spaces += INDENT_WIDTH;
		else if (ch === " ") spaces += 1;
	}
	const level = Math.floor(spaces / INDENT_WIDTH);
	return Math.min(level, MAX_LIST_INDENT);
}

/** A pending list item collected during line-by-line parsing. */
interface ListItem {
	indent: number;
	style: "ordered" | "bullet";
	content: string;
}

/**
 * Build a Block Kit `blocks` array from mrkdwn-style text.
 *
 * Walks the text line by line, producing a mix of
 * top-level blocks:
 *
 * - `rich_text` for paragraphs, lists, quotes and code
 *   fences. Inline formatting inside each line goes
 *   through {@link parseMrkdwnToElements}, which also
 *   handles markdown-style links, double-marker styles
 *   and the colour-swatch shield.
 * - `header` for `#`-prefixed lines.
 * - `divider` for thematic breaks (`---`, `***`, `___`).
 *
 * Returns the array plus a `hasStructure` flag the caller
 * can use to decide whether sending blocks (instead of
 * plain mrkdwn) actually changes how the message renders.
 */
export function mrkdwnToBlocks(text: string): {
	blocks: unknown[];
	hasStructure: boolean;
} {
	const outer: unknown[] = [];
	let rtChildren: unknown[] = [];
	let sectionLines: string[] = [];
	let listItems: ListItem[] = [];
	let quoteLines: string[] = [];
	let fenceLines: string[] = [];
	let inFence = false;
	let hasStructure = false;
	// Tracks a blank line that fell *between* two distinct
	// blocks (not inside an in-progress section). When the
	// next block opens, we emit a spacer section before it so
	// the rendered message preserves the visual gap the user
	// wrote in their input.
	let pendingSpacer = false;

	const emitSpacer = (): void => {
		if (!pendingSpacer || rtChildren.length === 0) {
			pendingSpacer = false;
			return;
		}
		rtChildren.push({
			type: "rich_text_section",
			elements: [{ type: "text", text: "\n" }],
		});
		pendingSpacer = false;
	};

	const flushSection = (): void => {
		// Trim trailing blank lines so the section ends cleanly.
		// Blank lines inside a section (between paragraphs) are
		// preserved — Slack renders the embedded newlines as the
		// paragraph break the user wrote.
		while (
			sectionLines.length > 0 &&
			sectionLines[sectionLines.length - 1] === ""
		) {
			sectionLines.pop();
		}
		if (sectionLines.length === 0) return;
		rtChildren.push({
			type: "rich_text_section",
			elements: parseMrkdwnToElements(sectionLines.join("\n")),
		});
		sectionLines = [];
	};

	const flushList = (): void => {
		if (listItems.length === 0) return;
		hasStructure = true;
		// Group adjacent items that share both indent and style.
		// A change in either ends the current `rich_text_list`
		// and starts a new one.
		let start = 0;
		while (start < listItems.length) {
			const first = listItems[start];
			let end = start + 1;
			while (
				end < listItems.length &&
				listItems[end].indent === first.indent &&
				listItems[end].style === first.style
			) {
				end++;
			}
			const block: Record<string, unknown> = {
				type: "rich_text_list",
				style: first.style,
				elements: listItems.slice(start, end).map((item) => ({
					type: "rich_text_section",
					elements: parseMrkdwnToElements(item.content),
				})),
			};
			if (first.indent > 0) block.indent = first.indent;
			rtChildren.push(block);
			start = end;
		}
		listItems = [];
	};

	const flushQuote = (): void => {
		if (quoteLines.length === 0) return;
		hasStructure = true;
		rtChildren.push({
			type: "rich_text_quote",
			elements: parseMrkdwnToElements(quoteLines.join("\n")),
		});
		quoteLines = [];
	};

	const flushFence = (): void => {
		hasStructure = true;
		rtChildren.push({
			type: "rich_text_preformatted",
			elements: [{ type: "text", text: fenceLines.join("\n") }],
		});
		fenceLines = [];
	};

	const flushParagraph = (): void => {
		flushSection();
		flushList();
		flushQuote();
	};

	// Close the current `rich_text` block (if any) and push
	// it to the outer blocks array. Used before emitting a
	// top-level block (header or divider) that can't live
	// inside `rich_text`.
	const closeRichText = (): void => {
		flushParagraph();
		if (rtChildren.length === 0) return;
		outer.push({ type: "rich_text", elements: rtChildren });
		rtChildren = [];
		// Block-level boundaries (header, divider) carry their
		// own visual separation — no rich_text spacer needed
		// when we cross into one.
		pendingSpacer = false;
	};

	for (const line of text.split("\n")) {
		if (inFence) {
			if (FENCE_LINE.test(line)) {
				flushFence();
				inFence = false;
			} else {
				fenceLines.push(line);
			}
			continue;
		}

		if (FENCE_LINE.test(line)) {
			flushParagraph();
			emitSpacer();
			inFence = true;
			continue;
		}

		const heading = line.match(HEADING_LINE);
		if (heading) {
			closeRichText();
			hasStructure = true;
			outer.push({
				type: "header",
				text: { type: "plain_text", text: heading[2], emoji: true },
			});
			continue;
		}

		if (DIVIDER_LINE.test(line)) {
			closeRichText();
			hasStructure = true;
			outer.push({ type: "divider" });
			continue;
		}

		// Blank line. Three cases:
		//   1. We're inside a section. Preserve the blank as an
		//      embedded newline so paragraphs separated by a
		//      blank line render with the spacing the user
		//      wrote. Slack's editor likewise keeps blank lines
		//      inside a single `rich_text_section`.
		//   2. We're inside a list or quote. Those can't span a
		//      blank line, so end them. The blank then becomes a
		//      spacer between the list/quote and whatever comes
		//      next.
		//   3. Nothing in progress. The blank line still earns a
		//      spacer once the next block opens.
		if (line.trim().length === 0) {
			if (sectionLines.length > 0) {
				sectionLines.push("");
			} else {
				flushList();
				flushQuote();
				pendingSpacer = true;
			}
			continue;
		}

		const ordered = line.match(ORDERED_LIST_LINE);
		if (ordered) {
			flushSection();
			flushQuote();
			emitSpacer();
			listItems.push({
				indent: indentLevel(ordered[1]),
				style: "ordered",
				content: ordered[3],
			});
			continue;
		}

		const unordered = line.match(UNORDERED_LIST_LINE);
		if (unordered) {
			flushSection();
			flushQuote();
			emitSpacer();
			listItems.push({
				indent: indentLevel(unordered[1]),
				style: "bullet",
				content: unordered[2],
			});
			continue;
		}

		const quote = line.match(QUOTE_LINE);
		if (quote) {
			flushSection();
			flushList();
			emitSpacer();
			quoteLines.push(quote[1]);
			continue;
		}

		// Plain paragraph line: end any list/quote run, then
		// accumulate into the current section.
		flushList();
		flushQuote();
		emitSpacer();
		sectionLines.push(line);
	}

	// End of input. An unterminated fence is still emitted —
	// dropping its content silently would be worse than
	// rendering a slightly-imperfect code block.
	if (inFence) flushFence();
	closeRichText();

	return { blocks: outer, hasStructure };
}

// ── Table building (sending) ────────────────────────────

/**
 * Build a Block Kit table block from a `SlackTable`.
 *
 * Converts mrkdwn strings in columns and rows to Block Kit
 * cell elements. Maps `columnSettings` to Block Kit's
 * `column_settings` format.
 */
export function tableToBlock(table: SlackTable): unknown {
	// Header row + data rows, each cell through mrkdwnToCell.
	const rows = [
		table.columns.map(mrkdwnToCell),
		...table.rows.map((row) => row.map(mrkdwnToCell)),
	];

	const block: Record<string, unknown> = { type: "table", rows };

	// Map column settings if present. Slack rejects null
	// entries in column_settings — use empty objects to skip.
	if (table.columnSettings?.length) {
		const settings = table.columnSettings.map((s) => {
			if (s == null) return {};
			const entry: Record<string, unknown> = {};
			if (s.align) entry.align = s.align;
			if (s.isWrapped !== undefined) entry.is_wrapped = s.isWrapped;
			return entry;
		});
		// Only include if at least one entry has properties.
		if (settings.some((s) => Object.keys(s).length > 0)) {
			block.column_settings = settings;
		}
	}

	return block;
}

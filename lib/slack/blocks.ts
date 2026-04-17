/**
 * Block Kit table support: tokenising mrkdwn to rich text
 * elements, rendering rich text elements back to readable
 * text, extracting tables from blocks, and building table
 * blocks for sending.
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
const FORMATTING_CHARS = /[<`*_~]/;

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

/** A token found during mrkdwn scanning. */
interface Token {
	/** Start index in the original string. */
	start: number;
	/** End index (exclusive). */
	end: number;
	/** The Block Kit element this token produces. */
	element: RichTextElement;
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

	// 1. Angle-bracket patterns (highest priority).
	for (const match of text.matchAll(ANGLE_BRACKET)) {
		tokens.push({
			start: match.index,
			end: match.index + match[0].length,
			element: parseAngleBracket(match[1]),
		});
	}

	// 2. Backtick patterns.
	for (const match of text.matchAll(BACKTICK)) {
		tokens.push({
			start: match.index,
			end: match.index + match[0].length,
			element: { type: "text", text: match[1], style: { code: true } },
		});
	}

	// 3. Inline style patterns.
	for (const match of text.matchAll(BOLD)) {
		tokens.push({
			start: match.index,
			end: match.index + match[0].length,
			element: { type: "text", text: match[2], style: { bold: true } },
		});
	}
	for (const match of text.matchAll(ITALIC)) {
		tokens.push({
			start: match.index,
			end: match.index + match[0].length,
			element: { type: "text", text: match[2], style: { italic: true } },
		});
	}
	for (const match of text.matchAll(STRIKE)) {
		tokens.push({
			start: match.index,
			end: match.index + match[0].length,
			element: { type: "text", text: match[2], style: { strike: true } },
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

		elements.push(token.element);
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

/**
 * Block Kit's table block, both ways: a `SlackTable` built into one for
 * sending, its cells through the mrkdwn tokeniser, and tables read back
 * out of the blocks Slack sent. It changes when Slack's table block
 * does, which moves both directions at once.
 */

import { mayHoldFormatting, parseMrkdwnToElements } from "./mrkdwn-tokens.ts";
import { renderRichTextCell } from "./rich-text-reading.ts";
import type { SlackColumnSetting, SlackTable } from "./types.ts";

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
	if (!mayHoldFormatting(text)) {
		return { type: "raw_text", text };
	}

	const elements = parseMrkdwnToElements(text);

	// If parsing produced a single unstyled text element,
	// the formatting characters were false positives (e.g.
	// "a < b"). Use raw_text.
	const [only] = elements;
	if (elements.length === 1 && only?.type === "text" && !only.style) {
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
	// entries in column_settings, so use empty objects to skip.
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

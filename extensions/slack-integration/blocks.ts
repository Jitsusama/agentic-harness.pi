/**
 * The Block Kit blocks an outgoing message is sent as.
 *
 * Two reasons to send blocks rather than text alone: the message has
 * a table, or its text has lists, quotes or code blocks that only
 * render as intended through `rich_text`. A send, a reply, an edit
 * and each message of a thread build them the same way here.
 */

import { isRecord } from "../../lib/internal/record.ts";
import {
	formatMentions,
	mrkdwnToBlocks,
	type SlackClient,
	tableToBlock,
} from "../../lib/slack/index.ts";
import type { SlackColumnSetting, SlackTable } from "../../lib/slack/types.ts";
import type { TableParam } from "./confirmation.ts";

/** Maximum rows in a Slack table block. */
const MAX_TABLE_ROWS = 100;

/** Maximum columns in a Slack table block. */
const MAX_TABLE_COLUMNS = 20;

/** Read a table from a tool param, when it has columns and rows. */
export function tableOf(raw: unknown): TableParam | undefined {
	if (!isRecord(raw)) return undefined;
	const { columns, rows, column_settings } = raw;
	if (!Array.isArray(columns) || !Array.isArray(rows)) return undefined;
	return {
		columns,
		rows,
		column_settings: Array.isArray(column_settings)
			? column_settings
			: undefined,
	};
}

/** Validate table dimensions and row consistency. */
export function validateTable(table: TableParam): string | undefined {
	if (table.columns.length === 0) return "Table must have at least one column.";
	if (table.columns.length > MAX_TABLE_COLUMNS) {
		return `Table exceeds ${MAX_TABLE_COLUMNS} column limit (got ${table.columns.length}).`;
	}
	if (table.rows.length > MAX_TABLE_ROWS) {
		return `Table exceeds ${MAX_TABLE_ROWS} row limit (got ${table.rows.length}).`;
	}
	for (const [i, row] of table.rows.entries()) {
		if (row.length !== table.columns.length) {
			return (
				`Row ${i + 1} has ${row.length} cells ` +
				`but table has ${table.columns.length} columns.`
			);
		}
	}
	return undefined;
}

/**
 * The blocks a message's text and table are sent as, or undefined
 * when its text alone renders as intended.
 *
 * When blocks are present, Slack's text field is only a notification
 * fallback and isn't drawn, so a table follows the text's own blocks
 * to keep the text visible.
 */
export async function messageBlocks(
	client: SlackClient,
	text: string | undefined,
	table: TableParam | undefined,
): Promise<unknown[] | undefined> {
	if (table) {
		const tableBlock = await buildTableBlock(client, table);
		const blocks: unknown[] = [];
		if (text) {
			const { blocks: leading } = await buildLeadingBlocks(client, text);
			blocks.push(...leading);
		}
		blocks.push(tableBlock);
		return blocks;
	}
	if (text) {
		const { blocks: leading, hasStructure } = await buildLeadingBlocks(
			client,
			text,
		);
		if (hasStructure) return leading;
	}
	return undefined;
}

/**
 * Resolve @mentions and build a Block Kit table block.
 *
 * Runs formatMentions on every cell, maps column settings,
 * and returns the Block Kit block ready for chat.postMessage.
 */
async function buildTableBlock(
	client: SlackClient,
	rawTable: TableParam,
	signal?: AbortSignal,
): Promise<unknown> {
	// Resolve @mentions in all cells.
	const columns = await Promise.all(
		rawTable.columns.map((c) => formatMentions(client, c, signal)),
	);
	const rows = await Promise.all(
		rawTable.rows.map((row) =>
			Promise.all(row.map((cell) => formatMentions(client, cell, signal))),
		),
	);

	// Map column_settings from snake_case to camelCase.
	let columnSettings: (SlackColumnSetting | null)[] | undefined;
	if (rawTable.column_settings) {
		columnSettings = rawTable.column_settings.map((s) => {
			if (s == null) return null;
			const entry = s as { align?: string; is_wrapped?: boolean };
			const setting: SlackColumnSetting = {};
			if (
				entry.align === "left" ||
				entry.align === "center" ||
				entry.align === "right"
			) {
				setting.align = entry.align;
			}
			if (typeof entry.is_wrapped === "boolean") {
				setting.isWrapped = entry.is_wrapped;
			}
			return Object.keys(setting).length > 0 ? setting : null;
		});
	}

	const table: SlackTable = { columns, rows, columnSettings };
	return tableToBlock(table);
}

/**
 * Resolve @mentions in `text` and parse the result into a
 * Block Kit blocks array (rich_text plus optional header
 * and divider blocks). `hasStructure` indicates whether the
 * blocks contain anything that would render differently as
 * blocks than as plain mrkdwn, and callers use it to decide
 * whether to attach blocks when no table is present.
 */
async function buildLeadingBlocks(
	client: SlackClient,
	text: string,
	signal?: AbortSignal,
): Promise<{ blocks: unknown[]; hasStructure: boolean }> {
	const formatted = await formatMentions(client, text, signal);
	return mrkdwnToBlocks(formatted);
}

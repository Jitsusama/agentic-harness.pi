import { describe, expect, it } from "vitest";
import {
	extractCellText,
	extractTables,
	mrkdwnToCell,
	tableToBlock,
} from "../../../lib/slack/blocks.ts";

/**
 * How a table goes to Slack as a Block Kit table block, and how one
 * Slack sent is read back: its cells and its column settings.
 */

describe("a table cell sent", () => {
	it("holds a zero-width space when empty, since Slack refuses empty text", () => {
		expect(mrkdwnToCell("")).toEqual({ type: "raw_text", text: "\u200B" });
	});

	it("stays raw text when nothing in it is formatting", () => {
		expect(mrkdwnToCell("plain words")).toEqual({
			type: "raw_text",
			text: "plain words",
		});
		expect(mrkdwnToCell("a < b")).toEqual({ type: "raw_text", text: "a < b" });
	});

	it("becomes rich text when it holds formatting", () => {
		expect(mrkdwnToCell("*on*")).toEqual({
			type: "rich_text",
			elements: [
				{
					type: "rich_text_section",
					elements: [{ type: "text", text: "on", style: { bold: true } }],
				},
			],
		});
	});
});

describe("a table block sent", () => {
	it("maps column settings, an unset column as an empty object", () => {
		const block = tableToBlock({
			columns: ["A", "B"],
			rows: [],
			columnSettings: [null, { align: "right", isWrapped: true }],
		});

		expect(block).toEqual({
			type: "table",
			rows: [
				[
					{ type: "raw_text", text: "A" },
					{ type: "raw_text", text: "B" },
				],
			],
			column_settings: [{}, { align: "right", is_wrapped: true }],
		});
	});

	it("leaves column settings out when none says anything", () => {
		const block = tableToBlock({
			columns: ["A"],
			rows: [],
			columnSettings: [null],
		});

		expect(block).not.toHaveProperty("column_settings");
	});
});

describe("a table read back", () => {
	it("reads a cell's text whether raw or rich, and nothing from another kind", () => {
		expect(extractCellText({ type: "raw_text", text: "x" })).toBe("x");
		expect(
			extractCellText({
				type: "rich_text",
				elements: [
					{
						type: "rich_text_section",
						elements: [{ type: "text", text: "y", style: { bold: true } }],
					},
				],
			}),
		).toBe("**y**");
		expect(extractCellText({ type: "image" })).toBe("");
	});

	it("skips blocks that aren't tables and tables without rows", () => {
		expect(
			extractTables([
				{ type: "section" },
				{ type: "table", rows: [] },
				{ type: "table" },
			]),
		).toEqual([]);
	});

	it("keeps column settings it understands and nulls the rest", () => {
		const [table] = extractTables([
			{
				type: "table",
				rows: [[{ type: "raw_text", text: "H" }]],
				column_settings: [
					{ align: "center", is_wrapped: false },
					{ align: "sideways" },
					null,
				],
			},
		]);

		expect(table).toEqual({
			columns: ["H"],
			rows: [],
			columnSettings: [{ align: "center", isWrapped: false }, null, null],
		});
	});
});

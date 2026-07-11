import { describe, expect, it } from "vitest";
import {
	extractTables,
	mrkdwnToBlocks,
	parseMrkdwnToElements,
	tableToBlock,
} from "../../../lib/slack/blocks.js";

describe("table round-trip", () => {
	it("recovers a table's columns and rows through a Block Kit block", () => {
		const table = {
			columns: ["Name", "Role"],
			rows: [
				["Ada", "Author"],
				["Grace", "Reviewer"],
			],
		};

		const recovered = extractTables([tableToBlock(table)]);

		expect(recovered).toHaveLength(1);
		expect(recovered[0]).toEqual(table);
	});
});

describe("parseMrkdwnToElements", () => {
	it("returns a single text element for plain text", () => {
		expect(parseMrkdwnToElements("just words")).toEqual([
			{ type: "text", text: "just words" },
		]);
	});

	it("tokenises a link with its url", () => {
		expect(parseMrkdwnToElements("<https://example.com>")).toEqual([
			{ type: "link", url: "https://example.com" },
		]);
	});
});

describe("mrkdwnToBlocks", () => {
	it("turns a fenced block into a preformatted element", () => {
		const { blocks, hasStructure } = mrkdwnToBlocks("```\ncode line\n```");

		expect(hasStructure).toBe(true);
		expect(JSON.stringify(blocks)).toContain("rich_text_preformatted");
	});
});

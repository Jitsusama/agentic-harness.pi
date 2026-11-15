import { describe, expect, it } from "vitest";
import { mrkdwnToBlocks } from "../../../lib/slack/blocks.ts";

/**
 * How a message's lines are laid out as Block Kit blocks: headings and
 * dividers as blocks of their own, lists, quotes and paragraphs inside
 * rich text, and whether any of it renders differently from mrkdwn.
 */

/** A rich_text_section of one unstyled text element. */
const section = (text: string) => ({
	type: "rich_text_section",
	elements: [{ type: "text", text }],
});

/** The spacer a blank line between two blocks leaves. */
const SPACER = section("\n");

describe("whether blocks change anything", () => {
	it("says plain prose needs no blocks", () => {
		expect(mrkdwnToBlocks("just a line")).toEqual({
			blocks: [{ type: "rich_text", elements: [section("just a line")] }],
			hasStructure: false,
		});
	});

	it("says an inline link mrkdwn can't draw needs blocks", () => {
		expect(mrkdwnToBlocks("see [a](https://a.io)")).toMatchObject({
			hasStructure: true,
		});
	});

	it("says a hex-like number needs blocks, for the swatch shield", () => {
		expect(mrkdwnToBlocks("PR #675891")).toMatchObject({
			hasStructure: true,
		});
	});
});

describe("blocks of their own", () => {
	it("lays a heading and a divider outside the rich text around them", () => {
		expect(mrkdwnToBlocks("intro\n## Title\nbody\n---\nend").blocks).toEqual([
			{ type: "rich_text", elements: [section("intro")] },
			{
				type: "header",
				text: { type: "plain_text", text: "Title", emoji: true },
			},
			{ type: "rich_text", elements: [section("body")] },
			{ type: "divider" },
			{ type: "rich_text", elements: [section("end")] },
		]);
	});
});

describe("lists", () => {
	it("groups items by style and indent, nesting by two spaces or a tab", () => {
		const converted = mrkdwnToBlocks(
			["- a", "  - b", "\t- c", "1. d", "2. e"].join("\n"),
		);

		expect(converted).toMatchObject({ hasStructure: true });
		expect(converted.blocks).toEqual([
			{
				type: "rich_text",
				elements: [
					{ type: "rich_text_list", style: "bullet", elements: [section("a")] },
					{
						type: "rich_text_list",
						style: "bullet",
						indent: 1,
						elements: [section("b"), section("c")],
					},
					{
						type: "rich_text_list",
						style: "ordered",
						elements: [section("d"), section("e")],
					},
				],
			},
		]);
	});

	it("nests no deeper than Slack allows", () => {
		const { blocks } = mrkdwnToBlocks(`${" ".repeat(40)}- deep`);

		expect(blocks).toEqual([
			{
				type: "rich_text",
				elements: [
					{
						type: "rich_text_list",
						style: "bullet",
						indent: 8,
						elements: [section("deep")],
					},
				],
			},
		]);
	});
});

describe("quotes, fences and blank lines", () => {
	it("joins quote lines into one quote", () => {
		expect(mrkdwnToBlocks("> one\n>two").blocks).toEqual([
			{
				type: "rich_text",
				elements: [
					{
						type: "rich_text_quote",
						elements: [{ type: "text", text: "one\ntwo" }],
					},
				],
			},
		]);
	});

	it("keeps a fence's lines as written, unterminated or not", () => {
		expect(mrkdwnToBlocks("```ts\n*not bold*").blocks).toEqual([
			{
				type: "rich_text",
				elements: [
					{
						type: "rich_text_preformatted",
						elements: [{ type: "text", text: "*not bold*" }],
					},
				],
			},
		]);
	});

	it("keeps a blank line between paragraphs inside their section", () => {
		expect(mrkdwnToBlocks("one\n\ntwo\n\n").blocks).toEqual([
			{ type: "rich_text", elements: [section("one\n\ntwo")] },
		]);
	});

	it("leaves a spacer where a blank line ends a list", () => {
		expect(mrkdwnToBlocks("- a\n\nafter").blocks).toEqual([
			{
				type: "rich_text",
				elements: [
					{ type: "rich_text_list", style: "bullet", elements: [section("a")] },
					SPACER,
					section("after"),
				],
			},
		]);
	});

	it("leaves no spacer before a heading, which separates itself", () => {
		expect(mrkdwnToBlocks("- a\n\n# H").blocks).toEqual([
			{
				type: "rich_text",
				elements: [
					{ type: "rich_text_list", style: "bullet", elements: [section("a")] },
				],
			},
			{ type: "header", text: { type: "plain_text", text: "H", emoji: true } },
		]);
	});
});

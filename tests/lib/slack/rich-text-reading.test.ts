import { describe, expect, it } from "vitest";
import { cacheUser } from "../../../lib/slack/resolvers/user.ts";
import { renderRichTextCell } from "../../../lib/slack/rich-text-reading.ts";

/**
 * How rich text Slack sent is read back as text, in the same marks the
 * message renderer uses: bold as `**`, links as markdown, mentions by
 * name where one is known.
 */

/** A rich_text cell holding one section of the given elements. */
function cell(...elements: unknown[]): unknown {
	return {
		type: "rich_text",
		elements: [{ type: "rich_text_section", elements }],
	};
}

describe("reading rich text back", () => {
	it("marks each style, bold outermost", () => {
		expect(
			renderRichTextCell(
				cell({
					type: "text",
					text: "x",
					style: { bold: true, italic: true, strike: true, code: true },
				}),
			),
		).toBe("**_~`x`~_**");
	});

	it("writes a link as markdown, or as its url when the text is the url", () => {
		expect(
			renderRichTextCell(
				cell(
					{ type: "link", url: "https://a.io", text: "A" },
					{ type: "text", text: " " },
					{ type: "link", url: "https://b.io", text: "https://b.io" },
				),
			),
		).toBe("[A](https://a.io) https://b.io");
	});

	it("names a known user and falls back to the id of an unknown one", () => {
		cacheUser("ada", "U0READ0001");

		expect(
			renderRichTextCell(
				cell(
					{ type: "user", user_id: "U0READ0001" },
					{ type: "text", text: " " },
					{ type: "user", user_id: "U0READ0002" },
				),
			),
		).toBe("@ada @U0READ0002");
	});

	it("writes a channel, a broadcast and an emoji", () => {
		expect(
			renderRichTextCell(
				cell(
					{ type: "channel", channel_id: "C0READ0001" },
					{ type: "broadcast", range: "channel" },
					{ type: "broadcast" },
					{ type: "emoji", name: "wave" },
				),
			),
		).toBe("#C0READ0001@channel@here:wave:");
	});

	it("drops an element of a kind it doesn't know", () => {
		expect(renderRichTextCell(cell({ type: "date", timestamp: 1 }))).toBe("");
	});

	it("answers nothing for a cell that isn't rich text", () => {
		expect(renderRichTextCell({ type: "raw_text", text: "x" })).toBe("");
	});
});

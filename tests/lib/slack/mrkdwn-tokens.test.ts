import { describe, expect, it } from "vitest";
import { parseMrkdwnToElements } from "../../../lib/slack/blocks.ts";

/**
 * How a line of mrkdwn becomes Block Kit's inline elements: Slack's
 * angle-bracket syntax, the markdown agents write instead, and the
 * shield that keeps a number from turning into a colour swatch.
 */

describe("Slack's angle-bracket syntax", () => {
	it("reads a user mention, dropping the name after the pipe", () => {
		expect(parseMrkdwnToElements("<@U0123ABCD|ada>")).toEqual([
			{ type: "user", user_id: "U0123ABCD" },
		]);
	});

	it("reads a broadcast by its range", () => {
		expect(parseMrkdwnToElements("<!here>")).toEqual([
			{ type: "broadcast", range: "here" },
		]);
	});

	it("reads a channel link, dropping the name after the pipe", () => {
		expect(parseMrkdwnToElements("<#C0123ABCD|general>")).toEqual([
			{ type: "channel", channel_id: "C0123ABCD" },
		]);
	});

	it("reads a link with its display text", () => {
		expect(parseMrkdwnToElements("<https://example.com|the site>")).toEqual([
			{ type: "link", url: "https://example.com", text: "the site" },
		]);
	});
});

describe("the markdown agents write instead", () => {
	it("turns a markdown link into a link", () => {
		expect(parseMrkdwnToElements("see [docs](https://x.io/d) now")).toEqual([
			{ type: "text", text: "see " },
			{ type: "link", url: "https://x.io/d", text: "docs" },
			{ type: "text", text: " now" },
		]);
	});

	it("keeps a code span inside a link's text as the link's text", () => {
		expect(parseMrkdwnToElements("[`run`](https://x.io)")).toEqual([
			{ type: "link", url: "https://x.io", text: "`run`" },
		]);
	});

	it("turns double markers into bold and strike", () => {
		expect(parseMrkdwnToElements("**big** and ~~gone~~")).toEqual([
			{ type: "text", text: "big", style: { bold: true } },
			{ type: "text", text: " and " },
			{ type: "text", text: "gone", style: { strike: true } },
		]);
	});
});

describe("inline styles and spans", () => {
	it("reads Slack's single-marker bold, italic and strike", () => {
		expect(parseMrkdwnToElements("*a* _b_ ~c~")).toEqual([
			{ type: "text", text: "a", style: { bold: true } },
			{ type: "text", text: " " },
			{ type: "text", text: "b", style: { italic: true } },
			{ type: "text", text: " " },
			{ type: "text", text: "c", style: { strike: true } },
		]);
	});

	it("leaves a marker inside a word as plain text", () => {
		expect(parseMrkdwnToElements("snake_case_name")).toEqual([
			{ type: "text", text: "snake_case_name" },
		]);
	});

	it("reads a code span and an emoji", () => {
		expect(parseMrkdwnToElements("`ls` :tada:")).toEqual([
			{ type: "text", text: "ls", style: { code: true } },
			{ type: "text", text: " " },
			{ type: "emoji", name: "tada" },
		]);
	});

	it("answers nothing for an empty string", () => {
		expect(parseMrkdwnToElements("")).toEqual([]);
	});
});

describe("the colour-swatch shield", () => {
	it("splits a hex-like number so Slack draws no swatch", () => {
		expect(parseMrkdwnToElements("PR #675891")).toEqual([
			{ type: "text", text: "PR " },
			{ type: "text", text: "#" },
			{ type: "text", text: "675891" },
		]);
	});

	it("leaves a number of a length no colour has alone", () => {
		expect(parseMrkdwnToElements("PR #12345")).toEqual([
			{ type: "text", text: "PR #12345" },
		]);
	});
});

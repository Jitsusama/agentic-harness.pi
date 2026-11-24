/** The host's reader of a message's text, held to pi-ai's own. */
import { contentText as pisText } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { contentText } from "../../../host/engine/hosted-agent/messages.ts";

const CONTENT: readonly [string, Parameters<typeof pisText>[0]][] = [
	["a string", "the whole of it"],
	[
		"text parts",
		[
			{ type: "text", text: "first" },
			{ type: "text", text: "second" },
		],
	],
	[
		"text beside an image, a thought and a tool call",
		[
			{ type: "text", text: "look at " },
			{ type: "image", data: "aGk=", mimeType: "image/png" },
			{ type: "thinking", thinking: "not said" },
			{ type: "toolCall", id: "call-1", name: "read", arguments: {} },
			{ type: "text", text: "this" },
		],
	],
	["no parts", []],
];

it.each(CONTENT)(
	"reads %s as pi-ai reads it with no separator",
	(_, content) => {
		expect(contentText(content)).toBe(pisText(content, ""));
	},
);

it("reads only a text part's text, whatever else carries a text field", () => {
	// A part pi-ai's types forbid, so it goes in as read from a log.
	const content: unknown = [
		{ type: "note", text: "not a text part" },
		{ type: "text", text: "said" },
	];
	expect(contentText(content)).toBe("said");
});

/**
 * Reading a tool result's text.
 *
 * Six renderers needed the same three lines of narrowing and had written them five
 * different ways, one of them with a cast the project asks people not to write.
 */

import { describe, expect, it } from "vitest";
import { firstText } from "../../../lib/ui/tool-result.js";

describe("the first thing a result says", () => {
	it("reads the text of a text block", () => {
		expect(firstText({ content: [{ type: "text", text: "said it" }] })).toBe(
			"said it",
		);
	});

	it("skips a leading image to find what was said", () => {
		// The call sites this replaces all read position zero, which is the same
		// answer whenever the first block is text and a worse one for a result that
		// leads with a picture and explains itself underneath.
		const said = firstText({
			content: [{ type: "image" }, { type: "text", text: "the caption" }],
		});

		expect(said).toBe("the caption");
	});

	it("says nothing for a result with no text at all", () => {
		// Every caller is composing a line to draw, so none of them can use a
		// failure here.
		expect(firstText({ content: [{ type: "image" }] })).toBe("");
	});

	it("says nothing for an empty result, or no result", () => {
		expect(firstText({ content: [] })).toBe("");
		expect(firstText({})).toBe("");
		expect(firstText(undefined)).toBe("");
	});

	it("does not mistake a block whose text is missing for one that has it", () => {
		// A block claiming to be text without any is malformed, and returning
		// undefined from a function that promises a string is how that reaches a
		// renderer as the word "undefined".
		expect(firstText({ content: [{ type: "text" }] })).toBe("");
	});

	it("keeps an empty string that was genuinely said", () => {
		// Distinct from the case above only in intent, but a block that says the
		// empty string is well formed, and the answer is the same either way.
		expect(firstText({ content: [{ type: "text", text: "" }] })).toBe("");
	});
});

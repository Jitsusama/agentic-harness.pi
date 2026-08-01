import { describe, expect, it } from "vitest";
import { wrapProse } from "../../../lib/prose/wrap";

const longest = (text: string) =>
	Math.max(...text.split("\n").map((line) => line.length));

describe("wrapping prose to the column rule", () => {
	it("breaks a long line at the width", () => {
		const text = `${"word ".repeat(40).trim()}`;

		expect(longest(wrapProse(text))).toBeLessThanOrEqual(80);
	});

	it("keeps the words and their order", () => {
		const text = "word ".repeat(40).trim();

		expect(wrapProse(text).split(/\s+/)).toEqual(text.split(" "));
	});

	it("leaves a line that already fits exactly as it was", () => {
		const text = "Short enough already.";

		expect(wrapProse(text)).toBe(text);
	});

	it("keeps paragraphs apart", () => {
		// A summary can be two paragraphs, since create joins a note and a
		// seeded excerpt with a blank line between them. Reflowing them
		// into one would silently merge two different statements.
		const text = `${"a ".repeat(50).trim()}\n\n${"b ".repeat(50).trim()}`;

		const wrapped = wrapProse(text);

		expect(wrapped).toContain("\n\n");
		expect(longest(wrapped)).toBeLessThanOrEqual(80);
	});

	it("does not reflow a line it must not touch", () => {
		// A markdown table row is exempt from the column rule and reflowing
		// one breaks the table outright, so width is not the only question.
		const row = `| ${"cell | ".repeat(20)}`;

		expect(wrapProse(row)).toBe(row);
	});

	it("never emits a word split across two lines", () => {
		const text = "supercalifragilistic ".repeat(10).trim();

		for (const line of wrapProse(text).split("\n")) {
			expect(line).not.toMatch(/supercalifragilisti$/);
		}
	});
});

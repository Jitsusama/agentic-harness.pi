import { describe, expect, it } from "vitest";
import { isWord, oneLine } from "../../../lib/mesh/one-line.ts";

describe("oneLine", () => {
	it.each([
		["a newline", "a\nb", "a b"],
		["a carriage return", "a\r\nb", "a b"],
		["a next-line", "a\u0085b", "a b"],
		["a line separator", "a\u2028b", "a b"],
		["an escape sequence", "a\u001b[2Kb", "a [2Kb"],
		["a right-to-left override", "a\u202eb", "a b"],
		["an isolate", "a\u2067b", "a b"],
	])("says text broken by %s on one line", (_, text, said) => {
		expect(oneLine(text)).toBe(said);
	});

	it("folds each run of breaks to one space and trims the ends", () => {
		expect(oneLine("\n a \u0085\n\tb \u202e")).toBe("a b");
	});

	it("leaves a line that was one as it was", () => {
		expect(oneLine("changing a, b and c (my test)")).toBe(
			"changing a, b and c (my test)",
		);
	});
});

describe("isWord", () => {
	it("takes one word", () => {
		expect(isWord("#quest/5gv2ah")).toBe(true);
	});

	it.each([
		["nothing", ""],
		["a space", "#harness x"],
		["a newline", "#harness\nOWNERQ"],
		["a next-line", "#harness\u0085OWNERQ"],
		["an escape", "bash\u001b[2K"],
		["a bidi override", "optimus\u202e"],
	])("refuses %s", (_, text) => {
		expect(isWord(text)).toBe(false);
	});
});

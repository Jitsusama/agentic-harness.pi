import { describe, expect, it } from "vitest";
import { isName, isWord, oneLine } from "../../../lib/mesh/one-line.ts";

describe("oneLine", () => {
	it.each([
		["a newline", "a\nb", "a b"],
		["a carriage return", "a\r\nb", "a b"],
		["a next-line", "a\u0085b", "a b"],
		["a line separator", "a\u2028b", "a b"],
		["an escape sequence", "a\u001b[2Kb", "a [2Kb"],
		["a right-to-left override", "a\u202eb", "a b"],
		["an isolate", "a\u2067b", "a b"],
		["a left-to-right mark", "a\u200eb", "a b"],
		["a right-to-left mark", "a\u200fb", "a b"],
		["an Arabic letter mark", "a\u061cb", "a b"],
		["a zero-width space", "a\u200bb", "a b"],
		["a word joiner", "a\u2060b", "a b"],
		["tag characters", "a\u{E0041}\u{E0042}b", "a b"],
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
		["a zero-width space", "optimus\u200bOWNERQ"],
	])("refuses %s", (_, text) => {
		expect(isWord(text)).toBe(false);
	});
});

describe("isName", () => {
	it.each([
		["a machine", "optimus"],
		["a cloud machine", "v2s-gcp-provider-9r6ra6-1795414159"],
		["a machine on a domain", "equilibrius.local"],
		["a tool", "mcp__tool_gateway"],
	])("takes %s", (_, text) => {
		expect(isName(text)).toBe(true);
	});

	it.each([
		["nothing", ""],
		["a comma", "x,quest:QEST-20261021-OWNERQ"],
		["a blank that isn't a space", "x\u2800quest"],
		["a quest id inside it", "x-QEST-20261021-OWNERQ"],
		["a quest id in other letters", "x-qest-20261021-ownerq"],
		["a leading dot", ".hidden"],
		["a newline", "optimus\nOWNERQ"],
	])("refuses %s", (_, text) => {
		expect(isName(text)).toBe(false);
	});
});

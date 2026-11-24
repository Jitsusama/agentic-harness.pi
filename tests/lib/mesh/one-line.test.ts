import { describe, expect, it } from "vitest";
import {
	isName,
	oneLine,
	plainQuotes,
} from "../../../lib/mesh/one-line.ts";

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
		["a variation selector", "a\uFE0Fb", "a b"],
		["supplementary variation selectors", "a\u{E0100}\u{E01EF}b", "a b"],
		["a Hangul filler", "a\u3164b", "a b"],
		["a halfwidth Hangul filler", "a\uFFA0b", "a b"],
		["a Hangul choseong filler", "a\u115Fb", "a b"],
		["a Hangul jungseong filler", "a\u1160b", "a b"],
		["a blank Braille pattern", "a\u2800b", "a b"],
		["a combining grapheme joiner", "a\u034Fb", "a b"],
		["a Khmer inherent vowel", "a\u17B4\u17B5b", "a b"],
		["a Mongolian free variation selector", "a\u180Bb\u180Fc", "a b c"],
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

describe("isName", () => {
	it.each([
		["a machine", "optimus"],
		["a cloud machine", "v2s-gcp-provider-9r6ra6-1795414159"],
		["a machine on a domain", "equilibrius.local"],
		["a tool", "mcp__tool_gateway"],
		["a name 64 long", "a".repeat(64)],
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
		["a trailing newline", "optimus\n"],
		["a name 65 long", "a".repeat(65)],
		["a quest id joined by underscores", "x_QEST_20261021_OWNERQ"],
		["a quest id joined by dots", "x.QEST.20261021.OWNERQ"],
		["a quest id run together", "xqest20261021ownerq"],
		["a quest id joined by a doubled dash", "x--QEST--20261021--OWNERQ"],
		["a quest id joined by mixed joiners", "quest_QEST-_20261021-OWNERQ"],
		["a quest id with its digits split", "x-QEST-2026-1021-OWNERQ"],
	])("refuses %s", (_, text) => {
		expect(isName(text)).toBe(false);
	});
});

describe("plainQuotes", () => {
	it.each([
		["a straight double quote", '"'],
		["a backtick", "`"],
		["curly double quotes", "\u201C\u201D"],
		["curly single quotes", "\u2018\u2019"],
		["a low double quote", "\u201E"],
		["a fullwidth double quote", "\uFF02"],
		["a fullwidth backtick", "\uFF40"],
		["a double prime", "\u2033"],
		["a modifier grave accent", "\u02CB"],
		["an ornamental quote", "\u275E"],
	])("says %s as a straight single quote", (_, quote) => {
		expect(plainQuotes(`y${quote}z`)).toBe(`y${"'".repeat(quote.length)}z`);
	});

	it("leaves accented letters and other punctuation as they are", () => {
		expect(plainQuotes("caf\u00E9 na\u0303o (a, b; c)")).toBe(
			"caf\u00E9 na\u0303o (a, b; c)",
		);
	});
});

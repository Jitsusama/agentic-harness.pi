/**
 * The nearest known word to one typed wrongly, as a command says it
 * back when a word or flag isn't one it knows.
 */

import { describe, expect, it } from "vitest";
import { nearestWord } from "../../../lib/internal/nearest.ts";

describe("the nearest known word", () => {
	it("names the closest word within half the typed word's length", () => {
		expect(nearestWord("lst", ["serve", "list", "ask", "told"])).toBe("list");
		expect(nearestWord("tlod", ["serve", "list", "ask", "told"])).toBe("told");
	});

	it("names none when every word is too far off", () => {
		expect(nearestWord("frobnicate", ["serve", "list"])).toBeUndefined();
	});

	it("takes the first of two words as near", () => {
		expect(nearestWord("as", ["ask", "asl"])).toBe("ask");
	});
});

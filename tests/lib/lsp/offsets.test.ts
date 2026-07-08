import { describe, expect, it } from "vitest";
import { byteToUtf16, utf16ToByte } from "../../../lib/lsp/offsets.js";

describe("byteToUtf16", () => {
	it("is the identity for pure ASCII", () => {
		expect(byteToUtf16("const x = 1", 6)).toBe(6);
	});

	it("collapses a two-byte character to one UTF-16 unit", () => {
		// "café": c a f é, where é is 2 UTF-8 bytes but 1 UTF-16 unit.
		expect(byteToUtf16("café", 3)).toBe(3); // before é
		expect(byteToUtf16("café", 5)).toBe(4); // after é (5 bytes, 4 units)
	});

	it("collapses an astral character to two UTF-16 units", () => {
		// "a😀b": 😀 is 4 UTF-8 bytes and 2 UTF-16 units.
		expect(byteToUtf16("a😀b", 5)).toBe(3); // before b: a(1) + 😀(2)
	});

	it("clamps a byte column past the end to the line's unit length", () => {
		expect(byteToUtf16("hi", 99)).toBe(2);
	});
});

describe("utf16ToByte", () => {
	it("is the identity for pure ASCII", () => {
		expect(utf16ToByte("const x = 1", 6)).toBe(6);
	});

	it("expands a two-byte character back to its byte offset", () => {
		expect(utf16ToByte("café", 4)).toBe(5);
	});

	it("expands an astral character back to its byte offset", () => {
		expect(utf16ToByte("a😀b", 3)).toBe(5);
	});

	it("round-trips every code-point boundary of a mixed line", () => {
		// Mid-surrogate columns are malformed and cannot round-trip,
		// so we walk the real code-point boundaries only.
		const line = "x=café+😀!";
		let unit = 0;
		for (const ch of line) {
			expect(byteToUtf16(line, utf16ToByte(line, unit))).toBe(unit);
			unit += ch.length;
		}
		expect(byteToUtf16(line, utf16ToByte(line, unit))).toBe(unit);
	});
});

import { describe, expect, it } from "vitest";
import { firstJsonArray } from "../../../lib/internal/json-array.js";

describe("firstJsonArray", () => {
	it("returns a bare array unchanged", () => {
		expect(firstJsonArray('["a","b"]')).toBe('["a","b"]');
	});

	it("stops at the first balanced array, ignoring trailing brackets", () => {
		expect(firstJsonArray('[{"x":1}] (see line [42])')).toBe('[{"x":1}]');
	});

	it("handles nested arrays", () => {
		expect(firstJsonArray("prefix [1,[2,3],4] suffix")).toBe("[1,[2,3],4]");
	});

	it("ignores brackets inside strings", () => {
		expect(firstJsonArray('["a]b","c"]')).toBe('["a]b","c"]');
	});

	it("respects escaped quotes inside strings", () => {
		expect(firstJsonArray('["a\\"]","b"]')).toBe('["a\\"]","b"]');
	});

	it("returns undefined when there is no array", () => {
		expect(firstJsonArray("no array here")).toBeUndefined();
	});

	it("returns undefined for an unterminated array", () => {
		expect(firstJsonArray("[1, 2, 3")).toBeUndefined();
	});
});

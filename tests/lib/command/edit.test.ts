import { describe, expect, it } from "vitest";
import { applyEdits } from "../../../lib/command/index.js";

describe("applyEdits", () => {
	it("returns the source unchanged when there are no edits", () => {
		expect(applyEdits("git commit", [])).toBe("git commit");
	});

	it("replaces only the targeted span", () => {
		const source = "git commit -m old --amend";
		const result = applyEdits(source, [
			{ span: { start: 14, end: 17 }, text: "new" },
		]);

		expect(result).toBe("git commit -m new --amend");
	});

	it("applies multiple disjoint edits regardless of given order", () => {
		const result = applyEdits("aaa bbb ccc", [
			{ span: { start: 8, end: 11 }, text: "CCC" },
			{ span: { start: 0, end: 3 }, text: "AAA" },
		]);

		expect(result).toBe("AAA bbb CCC");
	});

	it("throws when two edits overlap", () => {
		expect(() =>
			applyEdits("aaaaa", [
				{ span: { start: 0, end: 3 }, text: "x" },
				{ span: { start: 2, end: 4 }, text: "y" },
			]),
		).toThrow();
	});
});

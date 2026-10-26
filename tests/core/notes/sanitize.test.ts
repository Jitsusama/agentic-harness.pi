import { describe, expect, it } from "vitest";
import { sanitizeFilename } from "../../../lib/core/internal/notes/sanitize.ts";

describe("sanitizeFilename", () => {
	it("passes a clean name through unchanged", () => {
		expect(sanitizeFilename("A Clean Title")).toBe("A Clean Title");
	});

	it("replaces filesystem-invalid characters", () => {
		expect(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j')).toBe(
			"a-b-c-d-e-f-g-h-i-j",
		);
	});

	it("collapses internal whitespace runs", () => {
		expect(sanitizeFilename("a   b\t\tc")).toBe("a b c");
	});

	it("trims trailing dots and spaces", () => {
		expect(sanitizeFilename("trailing dots...  ")).toBe("trailing dots");
	});

	it("clamps to the given max length", () => {
		expect(sanitizeFilename("x".repeat(300), 10)).toHaveLength(10);
	});

	it("falls back to 'file' for an empty or all-invalid input", () => {
		expect(sanitizeFilename("")).toBe("file");
		expect(sanitizeFilename("   ")).toBe("file");
		expect(sanitizeFilename("...")).toBe("file");
	});
});

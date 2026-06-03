import { describe, expect, it } from "vitest";
import {
	escapeMarkdownStructure,
	sanitizeExcerpt,
	sanitizeHandle,
	sanitizeSingleLine,
} from "../../../lib/internal/quest/sanitize";

describe("sanitizeSingleLine", () => {
	it("strips newlines and collapses whitespace", () => {
		expect(sanitizeSingleLine("Hello\n\nWorld\r\nthere")).toBe(
			"Hello World there",
		);
	});

	it("clamps length", () => {
		const long = "a".repeat(500);
		expect(sanitizeSingleLine(long, 50).length).toBe(50);
	});
});

describe("escapeMarkdownStructure", () => {
	it("escapes leading heading markers with a zero-width space", () => {
		const result = escapeMarkdownStructure("# Important\nbody\n## Sub");
		expect(result.startsWith("\u200b# Important")).toBe(true);
		expect(result).toContain("\u200b## Sub");
		expect(result).toContain("body");
	});

	it("escapes fence and rule markers", () => {
		expect(
			escapeMarkdownStructure("```bash\nrm -rf /\n```").startsWith("\u200b```"),
		).toBe(true);
		expect(escapeMarkdownStructure("---").startsWith("\u200b---")).toBe(true);
	});

	it("leaves prose lines alone", () => {
		expect(escapeMarkdownStructure("just prose here")).toBe("just prose here");
	});
});

describe("sanitizeExcerpt", () => {
	it("clamps long excerpts and escapes structure", () => {
		const long = `${"x".repeat(500)}\n# pretend heading`;
		const result = sanitizeExcerpt(long);
		expect(result.length).toBeLessThanOrEqual(500);
		expect(result).toMatch(/\.\.\.$/);
	});

	it("escapes leading heading inside a normal excerpt", () => {
		expect(sanitizeExcerpt("First line.\n# Pretend Heading")).toContain(
			"\u200b# Pretend Heading",
		);
	});
});

describe("sanitizeHandle", () => {
	it("keeps only filename-safe handle characters", () => {
		expect(sanitizeHandle("evil/handle$with;spaces")).toBe(
			"evilhandlewithspaces",
		);
	});

	it("clamps length", () => {
		expect(sanitizeHandle("a".repeat(200)).length).toBeLessThanOrEqual(64);
	});
});

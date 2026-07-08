import { describe, expect, it } from "vitest";
import {
	applyProtocolEdits,
	fileToUri,
	fromProtocolPosition,
	languageIdFor,
	toProtocolPosition,
	uriToFile,
} from "../../../lib/lsp/standalone/document.js";

describe("uri round-trip", () => {
	it("maps an absolute path to a file URI and back", () => {
		const path = "/tmp/some dir/file.ts";
		expect(uriToFile(fileToUri(path))).toBe(path);
	});
});

describe("languageIdFor", () => {
	it("recognizes TypeScript and React variants", () => {
		expect(languageIdFor("a.ts")).toBe("typescript");
		expect(languageIdFor("a.tsx")).toBe("typescriptreact");
		expect(languageIdFor("a.jsx")).toBe("javascriptreact");
	});

	it("falls back to plaintext for the unknown", () => {
		expect(languageIdFor("a.rs")).toBe("plaintext");
	});
});

describe("position mapping", () => {
	const lines = ["const café = 1", "  return café"];

	it("converts a tool byte position into an LSP UTF-16 position", () => {
		// The '=' sits at byte column 12 on line 1 (é is 2 bytes, so the
		// bytes run ahead of the units), which is UTF-16 column 11 on
		// 0-indexed line 0.
		const p = toProtocolPosition(lines, { line: 1, character: 12 });
		expect(p).toEqual({ line: 0, character: 11 });
	});

	it("converts an LSP UTF-16 position back into a tool byte position", () => {
		const p = fromProtocolPosition(lines, { line: 0, character: 11 });
		expect(p).toEqual({ line: 1, character: 12 });
	});
});

describe("applyProtocolEdits", () => {
	it("applies a single-line replacement", () => {
		const text = "const oldName = 1;\n";
		const out = applyProtocolEdits(text, [
			{
				range: {
					start: { line: 0, character: 6 },
					end: { line: 0, character: 13 },
				},
				newText: "newName",
			},
		]);
		expect(out).toBe("const newName = 1;\n");
	});

	it("applies multiple edits on one line right-to-left without drift", () => {
		const text = "foo + foo";
		const rename = (start: number, end: number) => ({
			range: {
				start: { line: 0, character: start },
				end: { line: 0, character: end },
			},
			newText: "bar",
		});
		// Deliberately unordered: the helper must sort by offset.
		const out = applyProtocolEdits(text, [rename(0, 3), rename(6, 9)]);
		expect(out).toBe("bar + bar");
	});

	it("applies edits across multiple lines", () => {
		const text = "a\nx\nb\n";
		const out = applyProtocolEdits(text, [
			{
				range: {
					start: { line: 1, character: 0 },
					end: { line: 1, character: 1 },
				},
				newText: "Y",
			},
		]);
		expect(out).toBe("a\nY\nb\n");
	});
});

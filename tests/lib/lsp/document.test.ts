import { describe, expect, it } from "vitest";
import {
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

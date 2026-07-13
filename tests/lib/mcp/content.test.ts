import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	imageContent,
	joinTextContent,
	materializeResources,
	spillToFile,
	truncateForDisplay,
} from "../../../lib/mcp/content.js";
import type { McpContent, McpToolResult } from "../../../lib/mcp/types.js";

function result(
	content: McpContent[],
	extra: Partial<McpToolResult> = {},
): McpToolResult {
	return { content, ...extra };
}

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-content-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("joinTextContent", () => {
	it("joins text blocks and ignores non-text", () => {
		const r = result([
			{ type: "text", text: "one" },
			{ type: "image", data: "AAAA", mimeType: "image/png" },
			{ type: "text", text: "two" },
		]);
		expect(joinTextContent(r)).toBe("one\ntwo");
	});
});

describe("imageContent", () => {
	it("returns image blocks", () => {
		const r = result([{ type: "image", data: "AAAA", mimeType: "image/png" }]);
		expect(imageContent(r)).toEqual([
			{ type: "image", data: "AAAA", mimeType: "image/png" },
		]);
	});

	it("drops an image whose decoded size exceeds the cap", () => {
		// "AAAA" base64 decodes to 3 bytes.
		const r = result([{ type: "image", data: "AAAA", mimeType: "image/png" }]);
		expect(imageContent(r, { maxBytes: 2 })).toEqual([]);
	});
});

describe("truncateForDisplay", () => {
	it("passes short text through untouched", () => {
		const out = truncateForDisplay("a\nb", { maxLines: 40, maxBytes: 1000 });
		expect(out).toEqual({
			text: "a\nb",
			truncated: false,
			shownLines: 2,
			totalLines: 2,
		});
	});

	it("caps by line count and reports totals", () => {
		const text = ["1", "2", "3", "4", "5"].join("\n");
		const out = truncateForDisplay(text, { maxLines: 3, maxBytes: 10000 });
		expect(out.truncated).toBe(true);
		expect(out.shownLines).toBe(3);
		expect(out.totalLines).toBe(5);
		expect(out.text.split("\n").slice(0, 3)).toEqual(["1", "2", "3"]);
	});

	it("caps by byte budget", () => {
		const text = ["aaaa", "bbbb", "cccc"].join("\n");
		const out = truncateForDisplay(text, { maxLines: 100, maxBytes: 6 });
		expect(out.truncated).toBe(true);
		expect(out.shownLines).toBeLessThan(3);
	});
});

describe("materializeResources", () => {
	function resource(res: Record<string, unknown>): McpContent {
		return { type: "resource", resource: res };
	}

	it("writes a base64 blob and reports its byte length", () => {
		const r = result([
			resource({
				blob: Buffer.from("hello").toString("base64"),
				uri: "file:///x/hello.txt",
			}),
		]);
		const { saved, failures } = materializeResources(r, dir);
		expect(failures).toEqual([]);
		expect(saved).toHaveLength(1);
		expect(saved[0].bytes).toBe(5);
		expect(fs.readFileSync(saved[0].filePath, "utf8")).toBe("hello");
		expect(path.dirname(saved[0].filePath)).toBe(fs.realpathSync(dir));
	});

	it("confines a traversal filename to the target dir", () => {
		const r = result([resource({ text: "x", uri: "file:///a/b.txt" })], {
			structuredContent: { filename: "../../../etc/evil" },
		});
		const { saved } = materializeResources(r, dir);
		expect(saved).toHaveLength(1);
		expect(path.dirname(saved[0].filePath)).toBe(fs.realpathSync(dir));
		expect(path.basename(saved[0].filePath)).toBe("evil");
	});

	it("allocates a unique path when two resources collide", () => {
		const r = result([
			resource({ text: "one", uri: "file:///a/dup.txt" }),
			resource({ text: "two", uri: "file:///a/dup.txt" }),
		]);
		const { saved } = materializeResources(r, dir);
		expect(saved).toHaveLength(2);
		expect(saved[0].filePath).not.toBe(saved[1].filePath);
	});
});

describe("spillToFile", () => {
	it("writes the full text and returns a path inside the dir", () => {
		const p = spillToFile("full payload", dir);
		expect(path.dirname(p)).toBe(fs.realpathSync(dir));
		expect(fs.readFileSync(p, "utf8")).toBe("full payload");
	});
});

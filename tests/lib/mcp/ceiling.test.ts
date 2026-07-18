import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	contentByteSize,
	DEFAULT_RESULT_CEILING_BYTES,
	enforceResultCeiling,
} from "../../../lib/mcp/ceiling.js";
import type { McpContent, McpToolResult } from "../../../lib/mcp/types.js";

function result(content: McpContent[]): McpToolResult {
	return { content };
}

function textOf(content: McpContent[]): string {
	return content
		.filter(
			(b): b is Extract<McpContent, { type: "text" }> => b.type === "text",
		)
		.map((b) => b.text)
		.join("\n");
}

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-ceiling-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("contentByteSize", () => {
	it("sums utf-8 bytes across text blocks", () => {
		const content: McpContent[] = [
			{ type: "text", text: "abc" },
			{ type: "text", text: "de" },
		];
		expect(contentByteSize(content)).toBe(5);
	});

	it("counts a multi-byte character by its utf-8 byte length", () => {
		const content: McpContent[] = [{ type: "text", text: "\u00e9" }];
		expect(contentByteSize(content)).toBe(2);
	});

	it("counts an image by its base64 payload length", () => {
		const content: McpContent[] = [
			{ type: "image", data: "AAAA", mimeType: "image/png" },
		];
		expect(contentByteSize(content)).toBe(4);
	});

	it("counts a resource_link by its rendered form and ignores dropped blocks", () => {
		const content: McpContent[] = [
			{ type: "resource_link", uri: "file://x" },
			{ type: "audio", data: "AAAAAAAA", mimeType: "audio/wav" },
			{ type: "resource", resource: { blob: "AAAA" } },
		];
		expect(contentByteSize(content)).toBe("[resource: file://x]".length);
	});
});

describe("enforceResultCeiling", () => {
	it("leaves content under the ceiling untouched and writes nothing", () => {
		const content: McpContent[] = [{ type: "text", text: "small" }];
		const out = enforceResultCeiling(content, result(content), {
			limitBytes: 1024,
			storageDir: dir,
		});
		expect(out).toEqual(content);
		expect(fs.readdirSync(dir)).toHaveLength(0);
	});

	it("caps a single oversized line with no newline and spills the full payload", () => {
		const huge = "x".repeat(5000);
		const content: McpContent[] = [{ type: "text", text: huge }];
		const out = enforceResultCeiling(content, result(content), {
			limitBytes: 500,
			storageDir: dir,
		});
		expect(contentByteSize(out)).toBeLessThanOrEqual(500);
		const files = fs.readdirSync(dir);
		expect(files).toHaveLength(1);
		expect(fs.readFileSync(path.join(dir, files[0]), "utf-8")).toBe(huge);
		expect(textOf(out)).toContain(files[0]);
	});

	it("caps an aggregate of many blocks each individually under the limit", () => {
		const block = "y".repeat(200);
		const content: McpContent[] = Array.from({ length: 10 }, () => ({
			type: "text" as const,
			text: block,
		}));
		const out = enforceResultCeiling(content, result(content), {
			limitBytes: 500,
			storageDir: dir,
		});
		expect(contentByteSize(out)).toBeLessThanOrEqual(500);
	});

	it("drops an oversized image rather than slicing its base64", () => {
		const content: McpContent[] = [
			{ type: "image", data: "A".repeat(5000), mimeType: "image/png" },
		];
		const out = enforceResultCeiling(content, result(content), {
			limitBytes: 500,
			storageDir: dir,
		});
		expect(contentByteSize(out)).toBeLessThanOrEqual(500);
		expect(out.some((b) => b.type === "image")).toBe(false);
		expect(textOf(out)).toContain("image");
	});

	it("never splits a multi-byte character at the cut boundary", () => {
		const huge = "\u00e9".repeat(2000);
		const content: McpContent[] = [{ type: "text", text: huge }];
		const out = enforceResultCeiling(content, result(content), {
			limitBytes: 500,
			storageDir: dir,
		});
		expect(textOf(out)).not.toContain("\ufffd");
		expect(contentByteSize(out)).toBeLessThanOrEqual(500);
	});

	it("still caps and never returns raw when the spill fails", () => {
		// A regular file where the storage dir should be forces the mkdir to fail.
		const blocked = path.join(dir, "file-as-dir");
		fs.writeFileSync(blocked, "not a directory");
		const huge = "z".repeat(5000);
		const content: McpContent[] = [{ type: "text", text: huge }];
		const out = enforceResultCeiling(content, result(content), {
			limitBytes: 500,
			storageDir: blocked,
		});
		expect(contentByteSize(out)).toBeLessThanOrEqual(500);
		expect(textOf(out)).not.toContain(huge);
	});

	it("keeps a default ceiling at or above the 200KB soft default", () => {
		expect(DEFAULT_RESULT_CEILING_BYTES).toBeGreaterThanOrEqual(200 * 1024);
	});
});

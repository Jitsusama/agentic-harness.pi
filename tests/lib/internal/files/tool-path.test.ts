/**
 * A file tool's path is read as pi's read, write and edit tools read it,
 * so an interceptor looks at the file the tool will touch.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { toolPath } from "../../../../lib/internal/files/tool-path.ts";

describe("a file tool's path", () => {
	it("is read from the conversation's folder when relative", () => {
		expect(toolPath("notes/a.md", "/work/tree")).toBe("/work/tree/notes/a.md");
	});

	it("is kept when absolute", () => {
		expect(toolPath("/etc/hosts", "/work/tree")).toBe("/etc/hosts");
	});

	it("has a leading @ dropped, as a mention of a file is written", () => {
		expect(toolPath("@notes/a.md", "/work/tree")).toBe("/work/tree/notes/a.md");
	});

	it("reads ~ as the home folder", () => {
		expect(toolPath("~", "/work/tree")).toBe(homedir());
		expect(toolPath("~/a.md", "/work/tree")).toBe(join(homedir(), "a.md"));
	});

	it("reads a file address as the path it names", () => {
		expect(toolPath("file:///work/a.md", "/elsewhere")).toBe("/work/a.md");
	});

	it("has its unicode spaces made plain", () => {
		expect(toolPath("a\u00A0b\u202Fc.md", "/work/tree")).toBe(
			"/work/tree/a b c.md",
		);
	});
});

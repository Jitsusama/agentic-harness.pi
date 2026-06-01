import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readCommitFile } from "../../../../lib/internal/guardian/commit-file.js";

describe("readCommitFile", () => {
	it("reads an absolute path directly", () => {
		const dir = mkdtempSync(join(tmpdir(), "commit-file-"));
		const path = join(dir, "msg.txt");
		writeFileSync(path, "Absolute message.\n");
		expect(readCommitFile(path, null)).toBe("Absolute message.\n");
	});

	it("reads a relative path against the base directory", () => {
		const dir = mkdtempSync(join(tmpdir(), "commit-file-"));
		writeFileSync(join(dir, "rel.txt"), "Relative message.");
		expect(readCommitFile("rel.txt", dir)).toBe("Relative message.");
	});

	it("returns null when the file does not exist", () => {
		expect(readCommitFile("/nonexistent/path/msg.txt", null)).toBeNull();
	});
});

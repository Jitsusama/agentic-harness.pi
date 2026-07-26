import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spillText } from "../../../lib/result/spill.js";

describe("spillText", () => {
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "spill-"));
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("writes the text and returns where it went", () => {
		const written = spillText('{"a":1}', dir);

		expect(fs.readFileSync(written, "utf-8")).toBe('{"a":1}');
	});

	it("creates the directory when it is not there yet", () => {
		const nested = path.join(dir, "deep", "deeper");

		const written = spillText("hello", nested);

		expect(fs.readFileSync(written, "utf-8")).toBe("hello");
	});

	it("never overwrites an earlier payload", () => {
		const first = spillText("first", dir);
		const second = spillText("second", dir);

		expect(second).not.toBe(first);
		// Both must still resolve: a handle that started pointing at
		// somebody else's bytes would be worse than no store at all.
		expect(fs.readFileSync(first, "utf-8")).toBe("first");
		expect(fs.readFileSync(second, "utf-8")).toBe("second");
	});

	it("keeps a payload to its owner", () => {
		const written = spillText("private", dir);

		const mode = fs.statSync(written).mode & 0o777;
		expect(mode & 0o077).toBe(0);
	});
});

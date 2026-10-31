import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearWriting,
	WRITING,
	writeWhole,
} from "../../../lib/internal/write-whole.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "write-whole-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("writing a file whole", () => {
	it("replaces it, leaving nothing staged", () => {
		const file = join(dir, "queue.json");
		writeFileSync(file, "old");

		writeWhole(file, "new");

		expect(readFileSync(file, "utf8")).toBe("new");
		expect(readdirSync(dir).sort()).toEqual([WRITING, "queue.json"]);
		expect(readdirSync(join(dir, WRITING))).toEqual([]);
	});
});

describe("clearing what a writer left", () => {
	it("takes what is older than the time and keeps the rest", () => {
		const writing = join(dir, WRITING);
		mkdirSync(writing);
		writeFileSync(join(writing, "old"), "");
		writeFileSync(join(writing, "new"), "");
		const hourAgo = new Date(Date.now() - 3_600_000);
		utimesSync(join(writing, "old"), hourAgo, hourAgo);

		clearWriting(dir, Date.now() - 60_000);

		expect(readdirSync(writing)).toEqual(["new"]);
	});

	it("does nothing in a folder with no writing", () => {
		expect(() => clearWriting(dir, Date.now())).not.toThrow();
	});
});

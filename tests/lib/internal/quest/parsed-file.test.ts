/**
 * A quest file is parsed once while it is unchanged, and again as soon
 * as it changes, even when it changes within a clock tick of a read.
 */

import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parsedFiles } from "../../../../lib/internal/quest/parsed-file.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "parsed-file-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** A parser that counts how often it is asked. */
function counting() {
	const parser = {
		parses: 0,
		parse: (text: string) => {
			parser.parses += 1;
			return { text };
		},
	};
	return parser;
}

/** Write `text` at `path`, dated an hour back, as a file nobody is editing. */
function settled(path: string, text: string, hoursAgo = 1): void {
	writeFileSync(path, text);
	const when = new Date(Date.now() - hoursAgo * 3_600_000);
	utimesSync(path, when, when);
}

describe("a quest file parsed once", () => {
	it("is parsed once while it is unchanged", () => {
		const path = join(dir, "README.md");
		settled(path, "status: active");
		const parser = counting();
		const read = parsedFiles(parser.parse);

		expect(read(path).text).toBe("status: active");
		expect(read(path).text).toBe("status: active");
		expect(parser.parses).toBe(1);
	});

	it("is parsed again once it changes, even to the same size", () => {
		const path = join(dir, "README.md");
		settled(path, "- [ ] one", 2);
		const parser = counting();
		const read = parsedFiles(parser.parse);
		read(path);

		settled(path, "- [x] one", 1);
		expect(read(path).text).toBe("- [x] one");
		expect(parser.parses).toBe(2);
	});

	it("is parsed every time while it was written moments ago", () => {
		const path = join(dir, "README.md");
		writeFileSync(path, "- [ ] one");
		const parser = counting();
		const read = parsedFiles(parser.parse);
		read(path);
		// Written within the same clock tick, so its time may not move.
		writeFileSync(path, "- [x] one");

		expect(read(path).text).toBe("- [x] one");
		expect(parser.parses).toBe(2);
	});

	it("throws for a file that isn't there, as reading it would", () => {
		const read = parsedFiles(counting().parse);
		expect(() => read(join(dir, "gone.md"))).toThrow(/ENOENT/);
	});
});

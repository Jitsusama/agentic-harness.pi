/**
 * A quest file is parsed once while it is unchanged, and again as soon
 * as it changes, even when it changes within a clock tick of a read.
 */

import {
	mkdtempSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
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

	it("is parsed again after a same-size rewrite that puts its old time back", () => {
		const path = join(dir, "README.md");
		const when = new Date(Date.now() - 3_600_000);
		writeFileSync(path, "- [ ] one");
		utimesSync(path, when, when);
		const first = statSync(path, { bigint: true }).ctimeNs;
		const parser = counting();
		const read = parsedFiles(parser.parse);
		read(path);

		// Rewritten as `touch -r` would leave it: same size, same mtime.
		// Written until a clock tick has passed, so its change time moves.
		for (let tries = 0; tries < 1_000; tries++) {
			writeFileSync(path, "- [x] one");
			utimesSync(path, when, when);
			if (statSync(path, { bigint: true }).ctimeNs !== first) break;
		}
		expect(statSync(path, { bigint: true }).ctimeNs).not.toBe(first);
		expect(read(path).text).toBe("- [x] one");
	});

	it("is parsed every time while it was written moments ago", () => {
		const path = join(dir, "README.md");
		const tick = new Date();
		writeFileSync(path, "- [ ] one");
		utimesSync(path, tick, tick);
		const parser = counting();
		const read = parsedFiles(parser.parse);
		read(path);
		// Written again within the same clock tick, so its time stays put.
		writeFileSync(path, "- [x] one");
		utimesSync(path, tick, tick);

		expect(read(path).text).toBe("- [x] one");
		expect(parser.parses).toBe(2);
	});

	it("throws for a file that isn't there, as reading it would", () => {
		const read = parsedFiles(counting().parse);
		expect(() => read(join(dir, "gone.md"))).toThrow(/ENOENT/);
	});
});

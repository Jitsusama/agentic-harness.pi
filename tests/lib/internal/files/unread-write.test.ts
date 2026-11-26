/**
 * Whether a write would replace a file its conversation never saw: no
 * stamp, or a stamp the file has moved past, refuses; a new or empty
 * file, or the one the conversation saw, does not.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	stampNow,
	unreadWriteRefusal,
} from "../../../../lib/internal/files/unread-write.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "unread-write-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("a write over a file", () => {
	it("is refused when the conversation never read it", () => {
		const file = join(dir, "asks.jsonl");
		writeFileSync(file, '{"ask":1}\n');

		expect(
			unreadWriteRefusal(file, undefined),
			"a file with content and no stamp",
		).toMatch(/hasn't read it.*Read it first, or change it with edit/);
	});

	it("is refused when the file changed since the conversation saw it", () => {
		const file = join(dir, "asks.jsonl");
		writeFileSync(file, '{"ask":1}\n');
		const seen = stampNow(file);
		writeFileSync(file, '{"ask":1}\n{"ask":2}\n');

		expect(
			unreadWriteRefusal(file, seen),
			"a stamp the file has moved past",
		).toMatch(/has changed since.*Read it again first/);
	});

	it("goes ahead over the file as the conversation saw it", () => {
		const file = join(dir, "asks.jsonl");
		writeFileSync(file, '{"ask":1}\n');

		expect(
			unreadWriteRefusal(file, stampNow(file)),
			"the stamp it has now",
		).toBeUndefined();
	});

	it("goes ahead where no file is, or an empty one, or a folder", () => {
		const empty = join(dir, "empty");
		writeFileSync(empty, "");
		mkdirSync(join(dir, "folder"));

		expect(unreadWriteRefusal(join(dir, "new"), undefined), "new").toBe(
			undefined,
		);
		expect(unreadWriteRefusal(empty, undefined), "empty").toBeUndefined();
		expect(
			unreadWriteRefusal(join(dir, "folder"), undefined),
			"a folder, which the write tool fails on itself",
		).toBeUndefined();
	});
});

describe("a file's stamp", () => {
	it("is nothing where no file is", () => {
		expect(stampNow(join(dir, "gone")), "no file").toBeUndefined();
	});
});

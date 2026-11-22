/**
 * Writing a note beside git's own files writes only a plain file of one
 * name, since whatever ran in a tree may plant anything at that name.
 */

import { execFileSync } from "node:child_process";
import {
	closeSync,
	constants,
	linkSync,
	mkdtempSync,
	openSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writePlain } from "../../../lib/core/work/plain-file.ts";

/** What a file outside git's folder holds, which no note may change. */
const KEPT = "somebody's own words\n";

let root = "";
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "plain-file-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("writePlain", () => {
	it("writes a plain file whole, cutting what was longer", () => {
		const note = join(root, "note");
		writeFileSync(note, "a longer note than the next\n");

		expect(writePlain(note, "main\n")).toBe(true);
		expect(readFileSync(note, "utf8")).toBe("main\n");
	});

	it("writes nothing through a link, leaving the link and what it names", () => {
		const target = join(root, "elsewhere");
		writeFileSync(target, KEPT);
		const note = join(root, "note");
		symlinkSync(target, note);

		expect(writePlain(note, "main\n")).toBe(false);
		expect(readFileSync(target, "utf8")).toBe(KEPT);
		expect(readlinkSync(note)).toBe(target);
	});

	it("writes nothing into a file another name shares", () => {
		const target = join(root, "elsewhere");
		writeFileSync(target, KEPT);
		const note = join(root, "note");
		linkSync(target, note);

		expect(writePlain(note, "main\n")).toBe(false);
		expect(readFileSync(target, "utf8")).toBe(KEPT);
	});

	it("writes nothing into a fifo something reads", () => {
		// With a reader its open succeeds. The look at what it opened
		// keeps the note out, and the positional write, which a pipe
		// refuses, would too, so this pins the outcome, not the look.
		const note = join(root, "note");
		execFileSync("mkfifo", [note]);
		const reader = openSync(note, constants.O_RDONLY | constants.O_NONBLOCK);
		try {
			expect(writePlain(note, "main\n")).toBe(false);
		} finally {
			closeSync(reader);
		}
	});
});

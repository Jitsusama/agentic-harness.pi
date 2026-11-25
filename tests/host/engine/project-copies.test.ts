/**
 * The host's copies of a folder's .pi on a real disk: written whole,
 * reused for the same bytes, and removed once unused for a week.
 */
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { CopiedFile } from "../../../host/engine/project-code.ts";
import {
	COPIES_FOLDER,
	copyProject,
	UNUSED_FOR,
} from "../../../host/engine/project-copies.ts";

let root: string;
let agentDir: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "project-copies-"));
	agentDir = join(root, "agent");
	mkdirSync(agentDir);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const file = (place: string, text: string, mode = 0o644): CopiedFile => ({
	place,
	text: Buffer.from(text),
	mode,
});

/** The copy of `files`, failing the case when it can't be written. */
function copied(files: readonly CopiedFile[], now?: () => number): string {
	const made = copyProject(agentDir, join(root, "tree"), files, now);
	if (!("dir" in made)) throw new Error(made.failed);
	return made.dir;
}

it("writes every file in place with its mode, and reuses the copy for the same bytes", () => {
	const files = [
		file("extensions/run.sh", "#!/bin/sh", 0o755),
		file("SYSTEM.md", "words"),
	];
	const dir = copied(files);
	expect(readFileSync(join(dir, "extensions/run.sh"), "utf8")).toBe(
		"#!/bin/sh",
	);
	expect(statSync(join(dir, "extensions/run.sh")).mode & 0o777).toBe(0o755);
	expect(readFileSync(join(dir, "SYSTEM.md"), "utf8")).toBe("words");
	expect(copied([...files].reverse()), "the same bytes in any order").toBe(dir);
	expect(copied([file("SYSTEM.md", "other words")])).not.toBe(dir);
	expect(
		readdirSync(dirname(dir)).filter((name) => name.endsWith(".staged")),
		"nothing is left half written",
	).toEqual([]);
});

it("removes copies unused for a week, but none used within it", () => {
	const start = Date.now();
	const old = copied([file("SYSTEM.md", "old")], () => start);
	const used = copied([file("SYSTEM.md", "used")], () => start);
	const midweek = (start + UNUSED_FOR / 2) / 1000;
	utimesSync(used, midweek, midweek);
	const now = copied(
		[file("SYSTEM.md", "now")],
		() => start + UNUSED_FOR + 60_000,
	);
	expect(existsSync(old), "unused for over a week").toBe(false);
	expect(existsSync(used), "used within the week").toBe(true);
	expect(existsSync(now), "the copy just used").toBe(true);
});

it("says why when the agent folder can't hold a copy", () => {
	// A file where the copies' folder belongs refuses it, as a full or read-only disk would.
	writeFileSync(join(agentDir, COPIES_FOLDER), "");
	expect(
		copyProject(agentDir, join(root, "tree"), [file("SYSTEM.md", "words")]),
	).toEqual({ failed: expect.stringContaining("couldn't write its copy") });
});

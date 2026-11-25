/**
 * The host's copies of a folder's .pi on a real disk: written whole,
 * reused for the same bytes while pi hasn't changed their settings,
 * kept to the newest few, and removed once unused for a week, in any
 * folder.
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
	MOST_COPIES,
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

/** The copy of `files` for `tree`, failing the case when it can't be written. */
function copied(
	files: readonly CopiedFile[],
	now?: () => number,
	tree = "tree",
): string {
	const made = copyProject(agentDir, join(root, tree), files, now);
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

it("keeps a folder's newest copies and the one just used, so reloads can't fill the disk", () => {
	const start = Date.now();
	const made = Array.from({ length: MOST_COPIES + 2 }, (_, at) => {
		const dir = copied([file("SYSTEM.md", `words ${at}`)], () => start);
		// Each a second newer than the one before.
		const time = (start + at * 1000) / 1000;
		utimesSync(dir, time, time);
		return dir;
	});
	const last = copied([file("SYSTEM.md", "words now")], () => start + 60_000);
	const kept = made.filter((dir) => existsSync(dir));
	expect(kept, "the newest beside the one just used").toEqual(
		made.slice(-(MOST_COPIES - 1)),
	);
	expect(existsSync(last)).toBe(true);
	expect(
		readdirSync(dirname(last)).filter((name) => name.endsWith(".removing")),
		"nothing is left half removed",
	).toEqual([]);
});

it("removes a week-old copy of a folder that never loads again, and the folder with it", () => {
	const start = Date.now();
	const gone = copied([file("SYSTEM.md", "words")], () => start, "gone");
	// An hour after the last look over, so the next copy looks over every folder.
	copied(
		[file("SYSTEM.md", "words")],
		() => start + UNUSED_FOR + 2 * 60 * 60 * 1000,
		"other",
	);
	expect(existsSync(gone)).toBe(false);
	expect(existsSync(dirname(gone)), "its emptied folder goes too").toBe(false);
});

it("writes a copy again when pi changed its settings, and when it was removed as it was marked", () => {
	const files = [file("settings.json", '{"theme":"dark"}')];
	const dir = copied(files);
	writeFileSync(join(dir, "settings.json"), '{"packages":["npm:p"]}');
	expect(copied(files), "the same name").toBe(dir);
	expect(
		readFileSync(join(dir, "settings.json"), "utf8"),
		"the settings as checked",
	).toBe('{"theme":"dark"}');
	rmSync(dir, { recursive: true });
	expect(copied(files)).toBe(dir);
	expect(existsSync(join(dir, "settings.json"))).toBe(true);
});

it("says why when the agent folder can't hold a copy", () => {
	// A file where the copies' folder belongs refuses it, as a full or read-only disk would.
	writeFileSync(join(agentDir, COPIES_FOLDER), "");
	expect(
		copyProject(agentDir, join(root, "tree"), [file("SYSTEM.md", "words")]),
	).toEqual({ failed: expect.stringContaining("couldn't write its copy") });
});

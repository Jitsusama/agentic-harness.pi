/**
 * A folder's files read as asked, or mirrored for a host: what the first
 * ask gets, how soon another process's write shows, what this process's
 * own writes do, and that the poll keeps up when the watch can't.
 */
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	folderMirrors,
	folderRead,
	type MirroredFiles,
} from "../../../lib/internal/folder-mirror.ts";

let dir: string;
let offReads: number;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "folder-mirror-"));
	offReads = 0;
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** A file's words, read either way, counting the reads off the thread. */
const WORDS: MirroredFiles<string> = {
	suffix: ".txt",
	read: (path) => readFileSync(path, "utf8"),
	readOff: async (path) => {
		offReads += 1;
		return readFile(path, "utf8");
	},
};

/** Written as another process writes: a temporary name, renamed in. */
function put(name: string, words: string): void {
	writeFileSync(join(dir, `${name}.tmp`), words);
	renameSync(join(dir, `${name}.tmp`), join(dir, name));
}

/** The words of a folder's files, in the order it gives them. */
function wordsOf(files: ReadonlyMap<string, string | undefined>): string[] {
	return [...files.values()].filter((one) => one !== undefined);
}

describe("a folder read as asked", () => {
	it("reads the disk at each ask, keeping a parse while its file holds", () => {
		const folder = folderRead(dir, WORDS);
		expect(wordsOf(folder.files()), "no folder yet reads as empty").toEqual([]);
		put("a.txt", "first");
		put("b.json", "not ours");
		expect(wordsOf(folder.files()), "seen at once").toEqual(["first"]);
		expect(folder.file(join(dir, "a.txt")), "one file").toBe("first");
	});
});

describe("a host's mirror of a folder", () => {
	// A fresh mirror each test, so no test reads another's folder.
	const mirror = (times = {}) => folderMirrors(WORDS, times)(dir);

	it("answers its first ask from the disk at once, never empty", () => {
		put("a.txt", "here already");
		expect(wordsOf(mirror().files()), "the first ask reads").toEqual([
			"here already",
		]);
	});

	it("answers later asks from the mirror, seeing another's write within 2 s", async () => {
		const folder = mirror();
		folder.files();
		put("b.txt", "another process wrote this");
		expect(wordsOf(folder.files()), "not read on the caller's turn").toEqual(
			[],
		);
		await vi.waitFor(
			() =>
				expect(wordsOf(folder.files()), "seen within 2 s").toEqual([
					"another process wrote this",
				]),
			{ timeout: 2000 },
		);
	});

	it("shows this process's own write and removal at once", () => {
		const folder = mirror();
		folder.files();
		const path = join(dir, "own.txt");
		put("own.txt", "mine");
		folder.put(path, "mine");
		expect(folder.file(path), "put in at once").toBe("mine");
		rmSync(path);
		folder.drop(path);
		expect(folder.file(path), "gone at once").toBeUndefined();
	});

	it("keeps a write made while a refresh was reading", async () => {
		const folder = mirror();
		const path = join(dir, "own.txt");
		put("own.txt", "before");
		folder.files();
		const reading = folder.refresh();
		put("own.txt", "after");
		folder.put(path, "after");
		await reading;
		expect(folder.file(path), "not the file it replaced").toBe("after");
	});

	it("joins a refresh already reading rather than reading beside it", () => {
		const folder = mirror();
		expect(folder.refresh(), "one read in flight").toBe(folder.refresh());
	});

	it("keeps up by its poll when its folder is renamed out from under the watch", async () => {
		const folder = mirror({ pollMs: 100 });
		put("a.txt", "old folder");
		folder.files();
		// The watch follows the folder it was given, renamed away; a new
		// folder at the path is one it never hears.
		renameSync(dir, `${dir}-moved`);
		mkdirSync(dir);
		put("b.txt", "new folder");
		await vi.waitFor(
			() =>
				expect(wordsOf(folder.files()), "the poll read it").toEqual([
					"new folder",
				]),
			{ timeout: 2000 },
		);
		rmSync(`${dir}-moved`, { recursive: true, force: true });
	});

	it("stops reading once nobody has asked within its idle spell", async () => {
		const folder = mirror({ pollMs: 20, idleMs: 60 });
		folder.files();
		// Past the idle spell, with a few polls' room for the last to land.
		await new Promise((done) => setTimeout(done, 200));
		const read = offReads;
		put("c.txt", "written while idle");
		// Long enough for several polls, were any still running.
		await new Promise((done) => setTimeout(done, 200));
		expect(offReads, "no read while nobody asks").toBe(read);
		expect(
			wordsOf(folder.files()),
			"the last listing answers while a fresh one is read",
		).toEqual([]);
		await vi.waitFor(
			() =>
				expect(wordsOf(folder.files()), "read again once asked").toEqual([
					"written while idle",
				]),
			{ timeout: 2000 },
		);
	});
});

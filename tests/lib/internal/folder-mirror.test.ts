/**
 * A folder's files read as asked, or mirrored for a host: what the first
 * ask gets, how soon another process's write shows, what this process's
 * own writes do, and that the poll keeps up when the watch can't.
 */
import {
	chmodSync,
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

	// The council on #1721: a failed listing read as an empty folder, so a
	// plain pi's minute's look saw no peers.
	it("keeps its last listing when the folder can't be read, rather than none", async () => {
		const folder = folderRead(dir, WORDS);
		put("a.txt", "here");
		folder.files();
		chmodSync(dir, 0o000);
		try {
			expect(wordsOf(folder.files()), "read as asked").toEqual(["here"]);
			expect(wordsOf(await folder.refresh()), "read off the thread").toEqual([
				"here",
			]);
		} finally {
			chmodSync(dir, 0o700);
		}
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

	// The council on #1721: a first ask's read settled every write, so a
	// refresh listed before this process's publish then dropped it.
	it("keeps its own write when a refresh listed before it lands after the first ask", async () => {
		let release = (): void => undefined;
		const stalled = new Promise<void>((settle) => {
			release = settle;
		});
		const folder = folderMirrors<string>(
			{
				...WORDS,
				readOff: async (path) => {
					await stalled;
					return readFile(path, "utf8");
				},
			},
			{},
		)(dir);
		put("a.txt", "another's");
		const reading = folder.refresh();
		// Long enough for the refresh to list the folder and stall on a read.
		await new Promise((settle) => setTimeout(settle, 50));
		const path = join(dir, "own.txt");
		put("own.txt", "mine");
		folder.put(path, "mine");
		folder.files();
		release();
		await reading;
		expect(folder.file(path), "this process's publish").toBe("mine");
	});

	// The council on #1721: a refresh that listed before the thread's
	// first read landed after it and put its older listing back.
	it("keeps what its first ask read over a refresh that listed before it", async () => {
		let release = (): void => undefined;
		const stalled = new Promise<void>((settle) => {
			release = settle;
		});
		const folder = folderMirrors<string>(
			{
				...WORDS,
				readOff: async (path) => {
					await stalled;
					return readFile(path, "utf8");
				},
			},
			{},
		)(dir);
		put("a.txt", "listed first");
		const reading = folder.refresh();
		// Long enough for the refresh to list the folder and stall on a read.
		await new Promise((settle) => setTimeout(settle, 50));
		put("b.txt", "a peer since");
		folder.files();
		release();
		await reading;
		expect(wordsOf(folder.files()).sort(), "the newer listing").toEqual([
			"a peer since",
			"listed first",
		]);
	});

	// The council on #1721: only a synchronous ask kept the poll, so a host
	// asking less than each minute listed the folder on its thread each time.
	it("answers the first ask after an idle spell from a listing a look landed meanwhile", async () => {
		const folder = mirror({ pollMs: 20, idleMs: 60 });
		folder.files();
		// Past the idle spell, with a few polls' room for the last to land.
		await new Promise((done) => setTimeout(done, 200));
		put("c.txt", "listed by a look");
		await folder.refresh();
		put("d.txt", "written since");
		expect(
			wordsOf(folder.files()),
			"the look's listing, not one read on the thread",
		).toEqual(["listed by a look"]);
		await vi.waitFor(
			() =>
				expect(
					wordsOf(folder.files()).sort(),
					"read again off the thread",
				).toEqual(["listed by a look", "written since"]),
			{ timeout: 2000 },
		);
	});

	// The council on #1721: any failed listing emptied the mirror, so
	// every conversation read "no peers".
	it("keeps its last listing when the folder can't be read, rather than none", async () => {
		const folder = mirror();
		put("a.txt", "here");
		folder.files();
		chmodSync(dir, 0o000);
		try {
			await folder.refresh().catch(() => undefined);
			expect(wordsOf(folder.files()), "what it last read").toEqual(["here"]);
		} finally {
			chmodSync(dir, 0o700);
		}
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
		// The council on #1721: a listing an idle spell old let a new peer
		// start blind to what was published meanwhile.
		expect(
			wordsOf(folder.files()),
			"the first ask after an idle spell reads the disk",
		).toEqual(["written while idle"]);
	});
});

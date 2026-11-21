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
	watch,
	writeFileSync,
} from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type FolderMirror,
	folderMirrors,
	folderRead,
	type MirroredFiles,
} from "../../../../lib/internal/files/folder-mirror.ts";

// What the next listing waits on once it has read the folder's names,
// once a test sets it.
const listing = vi.hoisted(() => {
	const next: { wait?: () => Promise<void> } = {};
	return next;
});

// Counted, so a test sees when a mirror lists its whole folder again,
// and held, so it can stall one; each stat counted, so a test sees one.
vi.mock("node:fs/promises", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:fs/promises")>();
	const readdir = vi.fn(async (...args: Parameters<typeof real.readdir>) => {
		const names = await real.readdir(...args);
		const wait = listing.wait;
		listing.wait = undefined;
		await wait?.();
		return names;
	});
	const stat = vi.fn(async (path: string) => real.stat(path));
	return { ...real, readdir, stat };
});

// Wrapped, so a test can fail a mirror's watch, or have none be made.
vi.mock("node:fs", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:fs")>();
	return { ...real, watch: vi.fn(real.watch) };
});
const realWatch = (await vi.importActual<typeof import("node:fs")>("node:fs"))
	.watch;

/** The watches made on this test's folder, newest last. */
function watchesOfDir(): ReturnType<typeof watch>[] {
	const made = vi.mocked(watch).mock;
	return made.calls.flatMap(([path], index) => {
		const result = made.results[index];
		return path === dir && result?.type === "return" ? [result.value] : [];
	});
}

/** How often this test's folder was listed off the thread. */
function listings(): number {
	return vi.mocked(readdir).mock.calls.filter(([path]) => path === dir).length;
}

/**
 * Asks of a new mirror until its watch is made, then waits for the
 * listing the watch begins, so a test counts from a settled mirror.
 */
async function watching(folder: FolderMirror<string>): Promise<void> {
	await vi.waitFor(
		() => {
			folder.files();
			expect(watchesOfDir().length, "a watch made").toBeGreaterThan(0);
		},
		{ timeout: 2000 },
	);
	// The watch's listing begins only once a listing under way lands, so
	// one refresh may join that one: a turn of the loop later, the second
	// joins the watch's own.
	await folder.refresh();
	await new Promise((done) => setTimeout(done, 0));
	await folder.refresh();
}

let dir: string;
let offReads: number;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "folder-mirror-"));
	offReads = 0;
});
afterEach(() => {
	vi.mocked(watch).mockImplementation(realWatch);
	listing.wait = undefined;
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
/**
 * A read held until released: `reached` settles once one is held, so a
 * test knows the refresh listed the folder and stalled.
 */
function stalling() {
	let reach = (): void => undefined;
	let release = (): void => undefined;
	const reached = new Promise<void>((settle) => {
		reach = settle;
	});
	const held = new Promise<void>((settle) => {
		release = settle;
	});
	return {
		reached,
		release: () => release(),
		here: () => {
			reach();
			return held;
		},
	};
}

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
		const stall = stalling();
		const folder = folderMirrors<string>(
			{
				...WORDS,
				readOff: async (path) => {
					const words = await readFile(path, "utf8");
					await stall.here();
					return words;
				},
			},
			{},
		)(dir);
		const path = join(dir, "own.txt");
		put("own.txt", "before");
		folder.files();
		// Written again, so the refresh reads it, and holds what it read.
		put("own.txt", "between");
		const reading = folder.refresh();
		await stall.reached;
		put("own.txt", "after");
		folder.put(path, "after");
		stall.release();
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

	// The council on #1721: a refresh the thread overtook skipped its
	// listing but still landed what it had read, undoing a publish since.
	it("keeps its own publish over what a refresh the first ask overtook read", async () => {
		const stall = stalling();
		const folder = folderMirrors<string>(
			{
				...WORDS,
				readOff: async (path) => {
					const words = await readFile(path, "utf8");
					await stall.here();
					return words;
				},
			},
			{},
		)(dir);
		const path = join(dir, "own.txt");
		put("own.txt", "before");
		const reading = folder.refresh();
		await stall.reached;
		put("own.txt", "mine");
		folder.put(path, "mine");
		folder.files();
		stall.release();
		await reading;
		expect(folder.file(path), "this process's publish").toBe("mine");
	});

	// The council on #1721: past two idle spells the first ask read the
	// disk on the thread, though a read already stuck on it said it stalled.
	it("answers from its last listing while a stale read is still in flight", async () => {
		const stall = stalling();
		let stuck = false;
		const folder = folderMirrors<string>(
			{
				...WORDS,
				readOff: async (path) => {
					if (stuck) await stall.here();
					return readFile(path, "utf8");
				},
			},
			{ pollMs: 20, idleMs: 60 },
		)(dir);
		put("a.txt", "here");
		folder.files();
		// Past the idle spell and two more, so the last listing reads stale.
		await new Promise((done) => setTimeout(done, 300));
		// Written again, so the refresh reads it rather than keep its parse.
		put("a.txt", "rewritten");
		stuck = true;
		const reading = folder.refresh();
		// Stalled on a read, so the folder was listed before b.txt came.
		await stall.reached;
		put("b.txt", "since");
		expect(
			wordsOf(folder.files()),
			"the last listing, not one read on the thread",
		).toEqual(["here"]);
		stall.release();
		await reading;
		expect(wordsOf(folder.files()), "the stalled read, landed").toEqual([
			"rewritten",
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
		await watching(folder);
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

	// On 21 November seventy children each listed the mesh's presence each
	// second, and held the disk in btrfs's directory locks.
	it("lists a watched folder again only once its backstop has passed, however often it polls", async () => {
		put("a.txt", "here");
		const folder = mirror({ pollMs: 20, backstopMs: 60_000 });
		await watching(folder);
		const before = listings();
		// Long enough for a dozen polls, each asked for.
		for (let poll = 0; poll < 12; poll += 1) {
			await new Promise((done) => setTimeout(done, 25));
			folder.files();
		}
		expect(listings() - before, "no listing within the backstop").toBe(0);
	});

	it("lists a watched folder again once its backstop has passed", async () => {
		put("a.txt", "here");
		const folder = mirror({ pollMs: 20, backstopMs: 100 });
		await watching(folder);
		const before = listings();
		await vi.waitFor(
			() => {
				folder.files();
				expect(listings() - before, "listed at the backstop").toBeGreaterThan(
					0,
				);
			},
			{ timeout: 2000 },
		);
	});

	// The council on #1933: a watch made after the folder was listed heard
	// nothing of what changed between, which then waited half a minute for
	// the backstop.
	it("reads what changed before its watch was made, with no poll to list it", async () => {
		put("a.txt", "here");
		const folder = mirror({ pollMs: 60_000, backstopMs: 60_000 });
		folder.files();
		put("b.txt", "before the watch");
		await vi.waitFor(
			() =>
				expect(wordsOf(folder.files()).sort(), "the gap read").toEqual([
					"before the watch",
					"here",
				]),
			{ timeout: 2000 },
		);
	});

	// The gap is read by the poll while no watch is made; the new watch's
	// own listing is proven by the stalled-listing case below.
	it("watches again when its watch fails, its poll reading the gap meanwhile", async () => {
		put("a.txt", "here");
		const folder = mirror({ pollMs: 20, backstopMs: 60_000 });
		await watching(folder);
		const [first] = watchesOfDir();
		if (first === undefined) throw new Error("expected a watch on the folder");
		first.emit("error", new Error("the watch was lost"));
		put("b.txt", "in the gap");
		await vi.waitFor(
			() =>
				expect(wordsOf(folder.files()).sort(), "the gap read").toEqual([
					"here",
					"in the gap",
				]),
			{ timeout: 2000 },
		);
		expect(watchesOfDir(), "a new watch made").toHaveLength(2);
	});

	// The council on #1933: a listing under way when the watch is made may
	// have read the folder before it, so the watch's own begins after it.
	it("lists after a new watch once a listing under way has landed, not joining it", async () => {
		put("a.txt", "here");
		const folder = mirror({ pollMs: 20, backstopMs: 60_000 });
		await watching(folder);
		const [first] = watchesOfDir();
		if (first === undefined) throw new Error("expected a watch on the folder");
		// A deaf watch, so only a listing can find what the gap held.
		const elsewhere = join(dir, "elsewhere");
		mkdirSync(elsewhere);
		vi.mocked(watch).mockImplementationOnce(() =>
			realWatch(elsewhere, { persistent: false }),
		);
		const stall = stalling();
		listing.wait = stall.here;
		first.emit("error", new Error("the watch was lost"));
		await stall.reached;
		put("b.txt", "after the stalled listing read");
		await vi.waitFor(
			() => {
				folder.files();
				expect(watchesOfDir(), "the new watch made").toHaveLength(2);
			},
			{ timeout: 2000 },
		);
		stall.release();
		await vi.waitFor(
			() =>
				expect(folder.file(join(dir, "b.txt")), "the watch's own listing").toBe(
					"after the stalled listing read",
				),
			{ timeout: 2000 },
		);
	});

	it("lists an unwatched folder at each poll", async () => {
		vi.mocked(watch).mockImplementation(() => {
			throw new Error("no watch on this filesystem");
		});
		put("a.txt", "here");
		const folder = mirror({ pollMs: 20, backstopMs: 60_000 });
		folder.files();
		const before = listings();
		await vi.waitFor(
			() => {
				folder.files();
				expect(listings() - before, "a listing a poll").toBeGreaterThan(2);
			},
			{ timeout: 2000 },
		);
	});

	it("passes over a staged file the watch names until it is renamed in", async () => {
		put("a.txt", "here");
		const folder = mirror({ pollMs: 20, backstopMs: 60_000 });
		await watching(folder);
		writeFileSync(join(dir, "b.txt.41.staged"), "half written");
		put("c.txt", "after it");
		await vi.waitFor(
			() =>
				expect(wordsOf(folder.files()).sort(), "the later file read").toEqual([
					"after it",
					"here",
				]),
			{ timeout: 2000 },
		);
		expect(
			[...folder.files().keys()].some((path) => path.endsWith(".staged")),
			"the staged file is not kept",
		).toBe(false);
	});

	// The council on #1933: a name the watch gives is a file of the folder's
	// own, never one in a folder below it, which a listing never keeps.
	it("passes over a name the watch gives in a folder below its own", async () => {
		put("a.txt", "here");
		mkdirSync(join(dir, "below"));
		writeFileSync(join(dir, "below", "b.txt"), "below");
		const folder = mirror({ pollMs: 20, backstopMs: 60_000 });
		await watching(folder);
		const [made] = watchesOfDir();
		if (made === undefined) throw new Error("expected a watch on the folder");
		made.emit("change", "rename", join("below", "b.txt"));
		put("c.txt", "after it");
		await vi.waitFor(
			() =>
				expect(folder.file(join(dir, "c.txt")), "the later file read").toBe(
					"after it",
				),
			{ timeout: 2000 },
		);
		expect(wordsOf(folder.files()).sort(), "only the folder's own").toEqual([
			"after it",
			"here",
		]);
	});

	// The council on #1933: a named read that landed while a listing was
	// reading could be overwritten by that listing's older read.
	it("reads a named file only once a listing under way has landed", async () => {
		put("a.txt", "before");
		const folder = mirror({ pollMs: 20, backstopMs: 60_000 });
		await watching(folder);
		const stall = stalling();
		listing.wait = stall.here;
		const listed = folder.refresh();
		await stall.reached;
		put("a.txt", "changed");
		// Long enough for a named read that didn't wait to land.
		await new Promise((done) => setTimeout(done, 200));
		expect(folder.file(join(dir, "a.txt")), "held behind the listing").toBe(
			"before",
		);
		stall.release();
		await listed;
		await vi.waitFor(
			() =>
				expect(
					folder.file(join(dir, "a.txt")),
					"read once the listing landed, by it or the named read",
				).toBe("changed"),
			{ timeout: 2000 },
		);
	});

	it("keeps its own write over another's the watch names, until a listing", async () => {
		put("own.txt", "before");
		const folder = mirror({ pollMs: 20, backstopMs: 60_000 });
		await watching(folder);
		const path = join(dir, "own.txt");
		folder.put(path, "mine");
		put("own.txt", "theirs");
		put("other.txt", "after it");
		await vi.waitFor(
			() =>
				expect(folder.file(join(dir, "other.txt")), "the watch heard").toBe(
					"after it",
				),
			{ timeout: 2000 },
		);
		expect(folder.file(path), "this process's write stands").toBe("mine");
	});

	// The council on #1933: a stat that failed on a file still there
	// dropped a live peer until it published again.
	// Root reads a folder whatever its mode, so it can't lock one.
	it.skipIf(process.getuid?.() === 0)(
		"keeps a named file whose stat fails while the file is still there",
		async () => {
			put("a.txt", "here");
			const folder = mirror({ pollMs: 20, backstopMs: 60_000 });
			await watching(folder);
			const path = join(dir, "a.txt");
			// The mirror asks whether a file is gone only once its named read
			// failed; the read's own stat, in stamped-read.ts, is loaded by the
			// setup files before this mock and so isn't counted.
			const asked = () =>
				vi.mocked(stat).mock.calls.filter(([one]) => one === path).length;
			const before = asked();
			put("a.txt", "rewritten");
			// Before the watch's event is read, so the named read can't stat it.
			chmodSync(dir, 0o000);
			try {
				await vi.waitFor(
					() =>
						expect(
							asked(),
							"asked whether the file is gone, its named read failed",
						).toBeGreaterThan(before),
					{ timeout: 2000 },
				);
				// Long enough for what the read kept to land.
				await new Promise((done) => setTimeout(done, 200));
				expect(folder.file(path), "what was kept").toBe("here");
			} finally {
				chmodSync(dir, 0o700);
			}
		},
	);

	// The council on #1933: a read that fails after its stat, as a parse
	// of a torn file does, left a live peer as nothing.
	it("keeps a named file whose parse fails while the file is still there", async () => {
		put("a.txt", "here");
		const folder = folderMirrors(
			{
				...WORDS,
				readOff: async (path) => {
					const words = await readFile(path, "utf8");
					return words === "torn" ? undefined : words;
				},
			},
			{ pollMs: 20, backstopMs: 60_000 },
		)(dir);
		await watching(folder);
		put("a.txt", "torn");
		put("b.txt", "after it");
		await vi.waitFor(
			() =>
				expect(folder.file(join(dir, "b.txt")), "the later file read").toBe(
					"after it",
				),
			{ timeout: 2000 },
		);
		expect(folder.file(join(dir, "a.txt")), "what was kept").toBe("here");
	});

	// A listing stats every file, so only a file the watch names is read.
	it("reads a file its watch names alone, without listing the folder", async () => {
		for (const name of ["a", "b", "c", "d", "e"]) put(`${name}.txt`, name);
		const folder = mirror({ pollMs: 20, backstopMs: 60_000 });
		await watching(folder);
		const before = listings();
		put("c.txt", "c changed");
		put("f.txt", "f new");
		rmSync(join(dir, "a.txt"));
		await vi.waitFor(
			() =>
				expect(wordsOf(folder.files()).sort(), "each change seen").toEqual([
					"b",
					"c changed",
					"d",
					"e",
					"f new",
				]),
			{ timeout: 2000 },
		);
		expect(listings() - before, "the folder not listed").toBe(0);
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

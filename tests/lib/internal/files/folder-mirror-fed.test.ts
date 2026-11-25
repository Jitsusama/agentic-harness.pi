/**
 * A folder mirror whose kind is fed by what already follows its folder:
 * once fed it neither lists nor reads the folder, lets the feed's word
 * stand, and reads the folder itself where the feed is lost or won't
 * follow it.
 */
import {
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type FeedEvents,
	folderMirrors,
	type MirroredFiles,
} from "../../../../lib/internal/files/folder-mirror.ts";

// Counted, so a test sees whether a fed mirror lists its folder.
vi.mock("node:fs/promises", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:fs/promises")>();
	const readdir = vi.fn(async (...args: Parameters<typeof real.readdir>) =>
		real.readdir(...args),
	);
	return { ...real, readdir };
});

/** One feed a mirror asked for, and what the test says on it. */
interface Fed {
	readonly events: FeedEvents<string>;
	closed: boolean;
}

let dir: string;
let offReads: number;
let asked: Fed[];
// Whether the fake follows the folder at all, and how often it was asked.
let follows: boolean;
let feedCalls: number;
// Held, a read off the thread waits for it.
let gate: Promise<void> | undefined;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "folder-mirror-fed-"));
	offReads = 0;
	asked = [];
	follows = true;
	feedCalls = 0;
	gate = undefined;
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** A file's words, fed by the fake, counting the reads off the thread. */
const FED: MirroredFiles<string> = {
	suffix: ".txt",
	read: (path) => readFileSync(path, "utf8"),
	readOff: async (path) => {
		offReads += 1;
		if (gate !== undefined) await gate;
		return readFile(path, "utf8");
	},
	feed(folder, events) {
		if (folder === dir) feedCalls += 1;
		if (!follows || folder !== dir) return undefined;
		const one: Fed = { events, closed: false };
		asked.push(one);
		return {
			close() {
				one.closed = true;
			},
		};
	},
};

/** How often this test's folder was listed off the thread. */
function listings(): number {
	return vi.mocked(readdir).mock.calls.filter(([path]) => path === dir).length;
}

/** Written as another process writes: a temporary name, renamed in. */
function put(name: string, words: string): void {
	writeFileSync(join(dir, `${name}.tmp`), words);
	renameSync(join(dir, `${name}.tmp`), join(dir, name));
}

/** The words of a folder's files, in the order it gives them. */
function wordsOf(files: ReadonlyMap<string, string | undefined>): string[] {
	return [...files.values()].filter((one) => one !== undefined);
}

/** The feed the mirror asked for last, once it has asked. */
async function feedAsked(count = 1): Promise<Fed> {
	await vi.waitFor(() => expect(asked.length, "feeds asked").toBe(count));
	const last = asked.at(-1);
	if (last === undefined) throw new Error("no feed was asked");
	return last;
}

// A lost feed's folder is read at once unless a test spreads it.
const fedMirror = (times = {}) =>
	folderMirrors(FED, { pollMs: 20, feedFallbackMs: 0, ...times })(dir);

describe("a mirror its kind's feed follows", () => {
	it("takes its files from the feed, and once ready never lists or reads the folder", async () => {
		put("a.txt", "on disk");
		put("x.txt", "on disk alone");
		const folder = fedMirror({ backstopMs: 100 });
		expect(wordsOf(folder.files()), "the first ask reads the disk").toEqual([
			"on disk",
			"on disk alone",
		]);
		const fed = await feedAsked();
		fed.events.put("a.txt", "fed");
		fed.events.put("b.txt", "fed too");
		fed.events.put("b.md", "another kind");
		fed.events.ready();
		expect(wordsOf(folder.files()), "the feed's listing, whole").toEqual([
			"fed",
			"fed too",
		]);
		const listed = listings();
		const read = offReads;
		fed.events.put("c.txt", "new");
		fed.events.gone("a.txt");
		expect(wordsOf(folder.files()), "each change said").toEqual([
			"fed too",
			"new",
		]);
		put("d.txt", "written behind the feed's back");
		expect(wordsOf(await folder.refresh()), "a refresh reads nothing").toEqual([
			"fed too",
			"new",
		]);
		// Long enough for many polls, a watch's named read and a backstop.
		await new Promise((done) => setTimeout(done, 300));
		folder.files();
		expect(listings() - listed, "no listing while fed").toBe(0);
		// d.txt, written meanwhile, would be read were a watch still kept.
		expect(offReads - read, "no file read while fed").toBe(0);
	});

	it("lets the feed's word stand over its own write to the same file", async () => {
		const folder = fedMirror();
		folder.files();
		const fed = await feedAsked();
		fed.events.ready();
		const path = join(dir, "own.txt");
		folder.put(path, "mine");
		expect(folder.file(path), "its own write at once").toBe("mine");
		fed.events.put("own.txt", "as the feed has it");
		expect(folder.file(path), "the feed's word").toBe("as the feed has it");
	});

	it("reads the folder itself once the feed is lost, asks again later, and passes over what the lost one says", async () => {
		const folder = fedMirror({ feedAgainMs: 200 });
		folder.files();
		const fed = await feedAsked();
		fed.events.ready();
		fed.events.ended();
		expect(fed.closed, "the lost feed is closed").toBe(true);
		put("a.txt", "seen without the feed");
		await vi.waitFor(
			() =>
				expect(wordsOf(folder.files()), "read from the disk").toEqual([
					"seen without the feed",
				]),
			{ timeout: 2000 },
		);
		fed.events.put("late.txt", "said after it ended");
		expect(wordsOf(folder.files()), "the lost feed's late word").toEqual([
			"seen without the feed",
		]);
		await vi.waitFor(
			() => {
				folder.files();
				expect(asked.length, "asked again").toBe(2);
			},
			{ timeout: 2000 },
		);
		// Said while the next is still listing, it must not join that listing.
		fed.events.put("later.txt", "said while the next one lists");
		const again = await feedAsked(2);
		again.events.put("fresh.txt", "the new feed's");
		again.events.ready();
		expect(wordsOf(folder.files()), "the new feed's listing alone").toEqual([
			"the new feed's",
		]);
		// Read from the disk meanwhile, it watched the folder: ready drops it.
		const listed = listings();
		const read = offReads;
		put("behind.txt", "written behind the new feed's back");
		// Long enough for a watch's named read and many polls.
		await new Promise((done) => setTimeout(done, 300));
		folder.files();
		expect(listings() - listed, "no listing once fed again").toBe(0);
		expect(offReads - read, "no file read once fed again").toBe(0);
	});

	it("drops a feed that doesn't say every file in time, reads the folder, and asks again", async () => {
		const folder = fedMirror({ feedReadyMs: 100, feedAgainMs: 100 });
		folder.files();
		const fed = await feedAsked();
		await vi.waitFor(
			() => expect(fed.closed, "the silent feed closed").toBe(true),
			{ timeout: 2000 },
		);
		put("a.txt", "read here");
		await vi.waitFor(
			() =>
				expect(wordsOf(folder.files()), "read from the disk").toEqual([
					"read here",
				]),
			{ timeout: 2000 },
		);
		await feedAsked(2);
	});

	it("asks a ready feed again now and then, keeping the old one until the new says every file", async () => {
		const folder = fedMirror({ feedRefreshMs: 100 });
		folder.files();
		const fed = await feedAsked();
		fed.events.put("a.txt", "first");
		fed.events.ready();
		const again = await feedAsked(2);
		expect(fed.closed, "the old one serves meanwhile").toBe(false);
		fed.events.put("b.txt", "said while the new one lists");
		expect(wordsOf(folder.files()), "the old one's word stands").toEqual([
			"first",
			"said while the new one lists",
		]);
		again.events.put("c.txt", "as the new one has it");
		again.events.ready();
		expect(fed.closed, "the old one closed once replaced").toBe(true);
		expect(wordsOf(folder.files()), "the new one's listing, whole").toEqual([
			"as the new one has it",
		]);
		fed.events.put("d.txt", "the replaced one, late");
		expect(wordsOf(folder.files()), "the replaced one is passed over").toEqual([
			"as the new one has it",
		]);
	});

	it("goes back to the folder when a node stops answering, though its feed never ended", async () => {
		const folder = fedMirror({ feedRefreshMs: 50, feedReadyMs: 100 });
		folder.files();
		const fed = await feedAsked();
		fed.events.put("a.txt", "as the stuck node said");
		fed.events.ready();
		const again = await feedAsked(2);
		await vi.waitFor(
			() => {
				folder.files();
				expect(again.closed, "the unanswered one closed").toBe(true);
			},
			{ timeout: 2000 },
		);
		expect(fed.closed, "the stuck one closed too").toBe(true);
		put("b.txt", "read here");
		await vi.waitFor(
			() =>
				expect(wordsOf(folder.files()), "read from the disk").toEqual([
					"read here",
				]),
			{ timeout: 2000 },
		);
	});

	it("drops both feeds when the one asked to replace another ends, and asks again only later", async () => {
		const folder = fedMirror({ feedRefreshMs: 50, feedAgainMs: 600 });
		folder.files();
		const fed = await feedAsked();
		fed.events.put("a.txt", "as the node said");
		fed.events.ready();
		const again = await feedAsked(2);
		again.events.ended();
		expect(fed.closed, "the one it was to replace closed too").toBe(true);
		put("b.txt", "read here");
		await vi.waitFor(
			() =>
				expect(wordsOf(folder.files()), "read from the disk").toEqual([
					"read here",
				]),
			{ timeout: 2000 },
		);
		// Many polls, each of which would ask again were it not waiting.
		await new Promise((done) => setTimeout(done, 300));
		folder.files();
		expect(asked.length, "not asked again meanwhile").toBe(2);
		await vi.waitFor(
			() => {
				folder.files();
				expect(asked.length, "asked again after a while").toBe(3);
			},
			{ timeout: 3000 },
		);
	});

	it("keeps what a lost feed said until its own moment to read the folder", async () => {
		const random = vi.spyOn(Math, "random").mockReturnValue(1);
		try {
			const folder = fedMirror({ feedFallbackMs: 600, feedAgainMs: 5000 });
			folder.files();
			const fed = await feedAsked();
			fed.events.put("a.txt", "as the node said");
			fed.events.ready();
			put("b.txt", "on disk");
			const listed = listings();
			fed.events.ended();
			// Many polls, each of which would list it were it not waiting.
			await new Promise((done) => setTimeout(done, 300));
			expect(wordsOf(folder.files()), "the lost feed's word").toEqual([
				"as the node said",
			]);
			expect(listings() - listed, "not listed yet").toBe(0);
			await vi.waitFor(
				() =>
					expect(wordsOf(folder.files()), "read from the disk").toEqual([
						"on disk",
					]),
				{ timeout: 3000 },
			);
		} finally {
			random.mockRestore();
		}
	});

	// A node restarting ends the feed serving and the one asked to replace
	// it together, and every mirror must still read its folder at its own
	// moment rather than all at once.
	it("waits its own moment to read the folder when the feed serving ends while another is asked", async () => {
		const random = vi.spyOn(Math, "random").mockReturnValue(1);
		try {
			const folder = fedMirror({
				feedFallbackMs: 600,
				feedRefreshMs: 50,
				feedAgainMs: 5000,
			});
			folder.files();
			const fed = await feedAsked();
			fed.events.put("a.txt", "as the node said");
			fed.events.ready();
			const again = await feedAsked(2);
			put("b.txt", "on disk");
			const listed = listings();
			fed.events.ended();
			again.events.ended();
			// Many polls, each of which would list it were it not waiting.
			await new Promise((done) => setTimeout(done, 300));
			expect(wordsOf(folder.files()), "the lost feed's word").toEqual([
				"as the node said",
			]);
			expect(listings() - listed, "not listed yet").toBe(0);
			await vi.waitFor(
				() =>
					expect(wordsOf(folder.files()), "read from the disk").toEqual([
						"on disk",
					]),
				{ timeout: 3000 },
			);
		} finally {
			random.mockRestore();
		}
	});

	it("passes over a feed's word for a file in another folder", async () => {
		const folder = fedMirror();
		folder.files();
		const fed = await feedAsked();
		fed.events.put("a.txt", "here");
		fed.events.put("../b.txt", "beside it");
		fed.events.ready();
		expect(wordsOf(folder.files()), "its own folder's alone").toEqual(["here"]);
		// Joined, it would name a.txt itself.
		fed.events.gone("sub/../a.txt");
		expect(wordsOf(folder.files()), "not gone by another's name").toEqual([
			"here",
		]);
	});

	it("keeps its own write made while the feed was still listing", async () => {
		const folder = fedMirror();
		folder.files();
		const fed = await feedAsked();
		const path = join(dir, "own.txt");
		folder.put(path, "mine");
		fed.events.put("a.txt", "fed");
		fed.events.ready();
		expect(folder.file(path), "its write, which the listing predates").toBe(
			"mine",
		);
		expect(wordsOf(folder.files()), "beside the feed's listing").toEqual([
			"fed",
			"mine",
		]);
	});

	it("closes its feed once nobody asks, and comes back fed when asked again", async () => {
		const folder = fedMirror({ idleMs: 100 });
		folder.files();
		const fed = await feedAsked();
		fed.events.ready();
		await vi.waitFor(() => expect(fed.closed, "closed when idle").toBe(true), {
			timeout: 2000,
		});
		folder.files();
		const again = await feedAsked(2);
		again.events.put("a.txt", "fed again");
		again.events.ready();
		expect(wordsOf(folder.files()), "the new feed's").toEqual(["fed again"]);
	});

	it("lands no listing begun after the feed came ready, though it was asked for before", async () => {
		const folder = fedMirror();
		folder.files();
		const fed = await feedAsked();
		// Watched once a listing begun after the watch has been asked for.
		await vi.waitFor(() => expect(listings(), "listed").toBeGreaterThan(0), {
			timeout: 2000,
		});
		let release = (): void => undefined;
		gate = new Promise((done) => {
			release = done;
		});
		const read = offReads;
		put("named.txt", "named by the watch");
		await vi.waitFor(
			() => expect(offReads, "the named read began").toBeGreaterThan(read),
			{ timeout: 2000 },
		);
		// Queued behind the named read, so it lists only once that ends.
		const refreshed = folder.refresh();
		fed.events.put("a.txt", "fed");
		fed.events.ready();
		gate = undefined;
		release();
		await refreshed;
		expect(wordsOf(folder.files()), "the feed's listing stands").toEqual([
			"fed",
		]);
	});

	it("reads the folder itself where nothing follows it, and never asks again", async () => {
		follows = false;
		const folder = fedMirror({ feedAgainMs: 20 });
		folder.files();
		put("a.txt", "read here");
		await vi.waitFor(
			() =>
				expect(wordsOf(folder.files()), "read from the disk").toEqual([
					"read here",
				]),
			{ timeout: 2000 },
		);
		// Many times its wait to ask again.
		await new Promise((done) => setTimeout(done, 200));
		folder.files();
		expect(feedCalls, "asked once").toBe(1);
	});
});

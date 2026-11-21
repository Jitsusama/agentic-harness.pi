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
// Whether the fake follows the folder at all.
let follows: boolean;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "folder-mirror-fed-"));
	offReads = 0;
	asked = [];
	follows = true;
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
		return readFile(path, "utf8");
	},
	feed(folder, events) {
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

const fedMirror = (times = {}) =>
	folderMirrors(FED, { pollMs: 20, ...times })(dir);

describe("a mirror its kind's feed follows", () => {
	it("takes its files from the feed, and once ready never lists or reads the folder", async () => {
		put("a.txt", "on disk");
		put("x.txt", "on disk alone");
		const folder = fedMirror();
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
		fed.events.ended("lost");
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
	});

	it("never asks again a feed that refused its folder, and reads it itself", async () => {
		const folder = fedMirror({ feedAgainMs: 20 });
		folder.files();
		const fed = await feedAsked();
		fed.events.ended("refused");
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
		expect(asked.length, "asked once").toBe(1);
	});

	it("reads the folder itself where nothing follows it", async () => {
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
		expect(asked.length, "no feed").toBe(0);
	});
});

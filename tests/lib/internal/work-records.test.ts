/**
 * The work broker's records, read for the trees each session holds.
 *
 * Long because every rule of the one kept listing is tested here against
 * one mocked disk: when a reading starts, what it swaps in, how a
 * failure, a hung reading and a folder out of reach are answered, and
 * what a caller that asks once is handed. Split, each file would stand
 * up the same disk and the same module copies.
 */
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The disk as a reading off the thread sees it, which a test can stop
 * just after the records are read, while their trees are looked for,
 * and make fail.
 */
const disk = vi.hoisted(() => {
	let held: Promise<void> | undefined;
	let under: string | undefined;
	let release = (): void => {};
	let reach = (): void => {};
	let reached: Promise<void> = Promise.resolve();
	return {
		/**
		 * Each folder of records listed off the thread, once a listing: an
		 * earlier test's reading may still be running, so count one folder's.
		 */
		listed: [] as string[],
		/** How many times `dir` was listed off the thread. */
		listingsOf(dir: string): number {
			return this.listed.filter((one) => one === dir).length;
		},
		/** Each folder of records listed on the thread, once a listing. */
		listedOnThread: [] as string[],
		/** What a listing, on the thread or off it, does to the disk just before it lists. */
		onList: undefined as ((dir: string) => void) | undefined,
		/** The record names a listing leaves out, as btrfs did beside a rename. */
		hidden: new Set<string>(),
		/** Every file read on the thread, in order. */
		readsOnThread: [] as string[],
		/** Whether the next listings off the thread fail. */
		failing: false,
		/** A record a reading off the thread can't read, while one is named. */
		unreadable: undefined as string | undefined,
		/** A record a reading on the thread can't read, while one is named. */
		unreadableOnThread: undefined as string | undefined,
		/** Every record read off the thread, in order. */
		reads: [] as string[],
		/** Every tree looked for on disk off the thread, in order. */
		looked: [] as string[],
		/**
		 * Stop the readings whose trees lie under `root` where they look for
		 * them: only those, since an earlier test's reading may still run.
		 */
		stop(root: string): void {
			under = root;
			held = new Promise((done) => {
				release = done;
			});
			reached = new Promise((done) => {
				reach = done;
			});
		},
		/** Settles once a stopped reading has read its records. */
		stopped: (): Promise<void> => reached,
		/** Let a stopped reading go on. */
		go(): void {
			held = undefined;
			under = undefined;
			release();
		},
		async pass(path: string): Promise<void> {
			if (held === undefined || under === undefined) return;
			if (!path.startsWith(under)) return;
			reach();
			await held;
		},
	};
});

vi.mock("node:fs/promises", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:fs/promises")>();
	const readdir = (async (...args: Parameters<typeof real.readdir>) => {
		disk.listed.push(String(args[0]));
		disk.onList?.(String(args[0]));
		if (disk.failing) throw new Error("EMFILE: too many open files");
		const names = await real.readdir(...args);
		return names.filter(
			(name) => typeof name !== "string" || !disk.hidden.has(name),
		);
	}) as typeof real.readdir;
	const access = async (...args: Parameters<typeof real.access>) => {
		disk.looked.push(String(args[0]));
		await disk.pass(String(args[0]));
		return real.access(...args);
	};
	const readFile = (async (...args: Parameters<typeof real.readFile>) => {
		disk.reads.push(String(args[0]));
		if (disk.unreadable !== undefined && args[0] === disk.unreadable) {
			throw Object.assign(new Error("EMFILE: too many open files"), {
				code: "EMFILE",
			});
		}
		return real.readFile(...args);
	}) as typeof real.readFile;
	const mocked = { ...real, readdir, access, readFile };
	return { ...mocked, default: mocked };
});

vi.mock("node:fs", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:fs")>();
	const readdirSync = ((...args: Parameters<typeof real.readdirSync>) => {
		disk.listedOnThread.push(String(args[0]));
		disk.onList?.(String(args[0]));
		return real
			.readdirSync(...args)
			.filter((name) => typeof name !== "string" || !disk.hidden.has(name));
	}) as typeof real.readdirSync;
	const readFileSync = ((...args: Parameters<typeof real.readFileSync>) => {
		disk.readsOnThread.push(String(args[0]));
		if (
			disk.unreadableOnThread !== undefined &&
			args[0] === disk.unreadableOnThread
		) {
			throw Object.assign(new Error("EMFILE: too many open files"), {
				code: "EMFILE",
			});
		}
		return real.readFileSync(...args);
	}) as typeof real.readFileSync;
	const mocked = { ...real, readdirSync, readFileSync };
	return { ...mocked, default: mocked };
});

// Imported afresh: a setup file has already loaded both through the mesh's
// presence, before the disk above stood in, so the copies it holds read
// the real one.
vi.resetModules();
const { createTreeMemory, recallOff } = await import(
	"../../../lib/core/work/memory.ts"
);
const {
	isAgentCut,
	recordedTrees,
	treesHeldBy,
	treesHeldByNow,
	whenRefreshed,
} = await import("../../../lib/internal/work-records.ts");

/** Settles once what the disk was asked has had time to answer. */
const answered = (): Promise<void> =>
	// A real pause is the point: it shows no second reading started, and
	// nothing signals a reading that never began.
	new Promise((done) => setTimeout(done, 50));

/** Whether this runs as root, whom a folder's mode doesn't keep out. */
const asRoot = process.getuid?.() === 0;

/** What is said on stderr, a host's journal, from here on. */
function stderrSaid(): { naming(dir: string): string[] } {
	const said = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	return {
		naming: (dir) =>
			said.mock.calls
				.map(([text]) => String(text))
				.filter((text) => text.includes(dir)),
	};
}

/** A record of a tree at `path`, held by `sessions`, its folder made. */
function recorded(dir: string, path: string, sessions?: string[]): void {
	mkdirSync(path, { recursive: true });
	createTreeMemory(dir).remember({
		identity: { key: path.replaceAll("/", "-"), shareable: false },
		path,
		providerId: "git",
		...(sessions ? { sessions } : {}),
	});
}

/** The one record file in `dir` whose tree is at `path`. */
function recordOf(dir: string, path: string): string {
	const name = readdirSync(dir).find(
		(one) =>
			one.endsWith(".json") &&
			JSON.parse(readFileSync(join(dir, one), "utf8")).path === path,
	);
	if (!name) throw new Error(`no record of ${path}`);
	return join(dir, name);
}

/**
 * `record` rewritten in place to name `sessions`, which leaves its
 * folder's stamp as it was: a read made after it shows whether the
 * records were read again or kept.
 */
function rewriteInPlace(record: string, sessions: string[]): void {
	const held = JSON.parse(readFileSync(record, "utf8"));
	writeFileSync(record, JSON.stringify({ ...held, sessions }));
}

/**
 * `record` replaced by a rename to name `sessions`, with its folder's
 * times set to `tick` again: a write within the same tick of a coarse
 * clock, on a filesystem whose folder size a replaced entry doesn't
 * move, leaves the stamp just so.
 */
function replaceInTheSameTick(
	record: string,
	sessions: string[],
	tick: Date,
): void {
	const held = JSON.parse(readFileSync(record, "utf8"));
	const staged = `${record}.staged`;
	writeFileSync(staged, JSON.stringify({ ...held, sessions }));
	renameSync(staged, record);
	utimesSync(join(record, ".."), tick, tick);
}

// The folder time the last record written elsewhere set in each folder,
// so each lands in a tick of its own: per folder, since a test that
// fakes the time sets it minutes ahead.
const lastElsewhere = new Map<string, number>();

/**
 * A record of a tree at `path` held by `sessions`, written as another
 * process writes one: beside the folder and renamed in, so this
 * process's own writes don't know of it. Written in a tick of its own,
 * as a write a coarse clock's tick later, and answering that tick: a
 * folder's time comes from a clock that may not move between two
 * writes a test makes, and a write sharing a reading's tick is tested
 * on its own, with `replaceInTheSameTick`.
 */
function recordedElsewhere(
	dir: string,
	path: string,
	sessions: string[],
): Date {
	mkdirSync(path, { recursive: true });
	const key = path.replaceAll("/", "-");
	const staged = join(dir, `${key}.json.elsewhere.tmp`);
	writeFileSync(
		staged,
		JSON.stringify({
			identity: { key, shareable: false },
			path,
			providerId: "git",
			sessions,
		}),
	);
	renameSync(staged, join(dir, `${key}.json`));
	const at = Math.max(Date.now(), (lastElsewhere.get(dir) ?? 0) + 1);
	lastElsewhere.set(dir, at);
	const tick = new Date(at);
	utimesSync(dir, tick, tick);
	return tick;
}

/**
 * A folder whose record of tree x is half written when the first listing
 * reads it, and written whole by the second listing, which moves the
 * folder once more; the third listing holds still.
 */
function halfWritten(): {
	dir: string;
	x: string;
	half: { listings: number };
} {
	const root = mkdtempSync(join(tmpdir(), "records-"));
	const dir = join(root, "cut");
	const x = join(root, "trees", "x");
	recorded(dir, join(root, "trees", "one"), ["s-1"]);
	writeFileSync(join(dir, `${x.replaceAll("/", "-")}.json`), "{");
	const half = { listings: 0 };
	disk.onList = (listed) => {
		if (listed !== dir) return;
		half.listings += 1;
		if (half.listings === 1)
			recordedElsewhere(dir, join(root, "trees", "more"), ["s-2"]);
		if (half.listings === 2) recordedElsewhere(dir, x, ["s-3"]);
	};
	return { dir, x, half };
}

/**
 * A folder whose record of tree a is removed by the second listing, its
 * tree left standing, while the folder moves once more; the third
 * listing holds still.
 */
function removedMidway(): { dir: string; a: string; one: string } {
	const root = mkdtempSync(join(tmpdir(), "records-"));
	const dir = join(root, "cut");
	const one = join(root, "trees", "one");
	const a = join(root, "trees", "a");
	recorded(dir, one, ["s-1"]);
	recorded(dir, a, ["s-2"]);
	const record = recordOf(dir, a);
	let listings = 0;
	disk.onList = (listed) => {
		if (listed !== dir) return;
		listings += 1;
		if (listings === 1)
			recordedElsewhere(dir, join(root, "trees", "more"), ["s-3"]);
		if (listings === 2) {
			rmSync(record);
			const tick = new Date(Date.now() + 1000);
			utimesSync(dir, tick, tick);
		}
	};
	return { dir, a, one };
}

/** `dir` as last written a while ago, so a listing of it is settled. */
function settled(dir: string): void {
	const while_ago = new Date(Date.now() - 10_000);
	utimesSync(dir, while_ago, while_ago);
}

describe("the work broker's records", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		disk.go();
		disk.failing = false;
		disk.unreadable = undefined;
		disk.unreadableOnThread = undefined;
		disk.onList = undefined;
		disk.hidden.clear();
	});

	it("say which trees a session holds, and who holds each", () => {
		const root = mkdtempSync(join(tmpdir(), "records-"));
		const dir = join(root, "cut");
		recorded(dir, join(root, "trees", "one"), ["s-1", "s-2"]);
		recorded(dir, join(root, "trees", "two"), ["s-2"]);
		recorded(dir, join(root, "trees", "old"));

		expect(treesHeldBy("s-1", dir)).toEqual([join(root, "trees", "one")]);
		expect(treesHeldBy("s-2", dir).sort()).toEqual([
			join(root, "trees", "one"),
			join(root, "trees", "two"),
		]);
		expect(
			recordedTrees(dir).find((tree) => tree.path.endsWith("old")),
			"a record naming no session holds it for nobody",
		).toEqual({ path: join(root, "trees", "old"), sessions: [] });
	});

	// 85PKB2's terms, 17 November: one listing per process, by the stamp.
	it("are read once for every session in a process until a record changes", () => {
		const root = mkdtempSync(join(tmpdir(), "records-"));
		const dir = join(root, "cut");
		const one = join(root, "trees", "one");
		recorded(dir, one, ["s-1"]);
		settled(dir);
		expect(treesHeldBy("s-1", dir)).toEqual([one]);

		rewriteInPlace(recordOf(dir, one), ["s-2"]);

		expect(
			treesHeldBy("s-2", dir),
			"a second session reads the listing the first one read",
		).toEqual([]);
		expect(treesHeldBy("s-1", dir)).toEqual([one]);
		expect(isAgentCut(one, dir), "the trust prompt reads it too").toBe(true);
	});

	it("show a record this process writes at once, and read it from the folder once a reading lands", async () => {
		const root = mkdtempSync(join(tmpdir(), "records-"));
		const dir = join(root, "cut");
		const one = join(root, "trees", "one");
		const two = join(root, "trees", "two");
		recorded(dir, one, ["s-1"]);
		settled(dir);
		expect(treesHeldBy("s-1", dir)).toEqual([one]);

		recorded(dir, two, ["s-1"]);

		expect(treesHeldBy("s-1", dir).sort()).toEqual([one, two]);
		rewriteInPlace(recordOf(dir, two), ["s-1", "s-9"]);
		await whenRefreshed(dir);
		expect(
			treesHeldBy("s-9", dir),
			"the answer then comes from the reading, not the write",
		).toEqual([two]);
	});

	it("show this process's own cut at once to a caller naming the folder by its real path", () => {
		const real = mkdtempSync(join(tmpdir(), "records-"));
		const linked = `${real}-linked`;
		symlinkSync(real, linked);
		const written = join(linked, "cut");
		const one = join(real, "trees", "one");
		const two = join(real, "trees", "two");
		recorded(written, one, ["s-1"]);
		settled(written);
		const read = realpathSync(written);
		expect(treesHeldBy("s-1", read)).toEqual([one]);
		expect(treesHeldBy("s-1", written)).toEqual([one]);

		recorded(written, two, ["s-1"]);

		expect(treesHeldBy("s-1", read).sort()).toEqual([one, two]);
		createTreeMemory(read).forget(one);
		expect(treesHeldBy("s-1", written)).toEqual([two]);
	});

	// The second council on #1962: a folder nobody can look at grants
	// nothing, as before the listing was kept, and says why.
	it.skipIf(asRoot)(
		"answer none while their folder can't be looked at, saying so once, and the kept listing once it can",
		() => {
			const root = mkdtempSync(join(tmpdir(), "records-"));
			const dir = join(root, "cut");
			const one = join(root, "trees", "one");
			recorded(dir, one, ["s-1"]);
			settled(dir);
			expect(treesHeldBy("s-1", dir)).toEqual([one]);
			const said = stderrSaid();

			chmodSync(root, 0o000);
			try {
				expect(() => statSync(dir), "the folder can't be looked at").toThrow();
				expect(
					treesHeldBy("s-1", dir),
					"a folder that can't be looked at grants nothing",
				).toEqual([]);
				expect(
					isAgentCut(one, dir),
					"nor does it vouch a folder an agent cut",
				).toBe(false);
				expect(said.naming(dir), "said once").toHaveLength(1);
			} finally {
				chmodSync(root, 0o700);
			}
			const listed = disk.listingsOf(dir);
			expect(treesHeldBy("s-1", dir)).toEqual([one]);
			expect(disk.listingsOf(dir), "the listing was kept, not read again").toBe(
				listed,
			);
		},
	);

	// Git calls such an index entry racily clean.
	it("are read again once a read made just after their folder was written is old enough", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const root = mkdtempSync(join(tmpdir(), "records-"));
		const dir = join(root, "cut");
		const one = join(root, "trees", "one");
		recorded(dir, one, ["s-1"]);
		// A second ago: a clock a filesystem stamps by can be that coarse,
		// and a machine that busy, so the rule's window must reach past it.
		const now = Date.now();
		const tick = new Date(now - 1_000);
		utimesSync(dir, tick, tick);
		const stamp = statSync(dir).mtimeMs;
		expect(treesHeldBy("s-1", dir)).toEqual([one]);

		replaceInTheSameTick(recordOf(dir, one), ["s-2"], tick);
		expect(statSync(dir).mtimeMs, "the folder's time is as it was").toBe(stamp);
		expect(
			treesHeldBy("s-2", dir),
			"within the window every caller shares the one read",
		).toEqual([]);

		vi.setSystemTime(now + 2_001);
		treesHeldBy("s-2", dir);
		await whenRefreshed(dir);
		expect(
			treesHeldBy("s-2", dir),
			"a record replaced in the tick its listing was read in is read",
		).toEqual([one]);

		rewriteInPlace(recordOf(dir, one), ["s-3"]);
		expect(treesHeldBy("s-3", dir), "and kept from then on").toEqual([]);
	});

	it("are kept when their folder's time is ahead of the clock", () => {
		const root = mkdtempSync(join(tmpdir(), "records-"));
		const dir = join(root, "cut");
		const one = join(root, "trees", "one");
		recorded(dir, one, ["s-1"]);
		const ahead = new Date(Date.now() + 60_000);
		utimesSync(dir, ahead, ahead);
		expect(treesHeldBy("s-1", dir)).toEqual([one]);

		rewriteInPlace(recordOf(dir, one), ["s-2"]);

		expect(
			treesHeldBy("s-2", dir),
			"a listing is read again at every call until the clock catches up",
		).toEqual([]);
	});

	it("drop a tree gone from the disk within a minute, its record left", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const root = mkdtempSync(join(tmpdir(), "records-"));
		const dir = join(root, "cut");
		const one = join(root, "trees", "one");
		const two = join(root, "trees", "two");
		recorded(dir, one, ["s-1"]);
		recorded(dir, two, ["s-1"]);
		settled(dir);
		expect(treesHeldBy("s-1", dir).sort()).toEqual([one, two]);

		rmSync(one, { recursive: true });
		expect(
			treesHeldBy("s-1", dir).sort(),
			"the listing is kept, its trees not looked for, within the minute",
		).toEqual([one, two]);
		vi.setSystemTime(Date.now() + 61_000);
		expect(
			treesHeldBy("s-1", dir).sort(),
			"the trees are looked for off the thread, the listing answered meanwhile",
		).toEqual([one, two]);
		await whenRefreshed(dir);

		expect(treesHeldBy("s-1", dir)).toEqual([two]);
	});

	// 85PKB2's terms, 21 November: answer from the last listing while one
	// reading off the thread brings it up to date.
	it("answer from the last listing while another process's write is read off the thread", async () => {
		const root = mkdtempSync(join(tmpdir(), "records-"));
		const dir = join(root, "cut");
		const one = join(root, "trees", "one");
		const two = join(root, "trees", "two");
		recorded(dir, one, ["s-1"]);
		settled(dir);
		expect(treesHeldBy("s-1", dir)).toEqual([one]);

		recordedElsewhere(dir, two, ["s-1"]);

		expect(
			treesHeldBy("s-1", dir),
			"another process's cut is seen one read late",
		).toEqual([one]);
		await whenRefreshed(dir);
		expect(treesHeldBy("s-1", dir).sort()).toEqual([one, two]);
	});

	it("show a tree this process cut or forgot at once, whatever a reading started before says", async () => {
		const root = mkdtempSync(join(tmpdir(), "records-"));
		const dir = join(root, "cut");
		const one = join(root, "trees", "one");
		const two = join(root, "trees", "two");
		const three = join(root, "trees", "three");
		recorded(dir, one, ["s-1"]);
		settled(dir);
		expect(treesHeldBy("s-1", dir)).toEqual([one]);

		disk.stop(root);
		recordedElsewhere(dir, two, ["s-1"]);
		treesHeldBy("s-1", dir);
		await disk.stopped();
		createTreeMemory(dir).forget(one);
		recorded(dir, three, ["s-1"]);
		expect(
			treesHeldBy("s-1", dir),
			"this process's own cut and forget show before any reading",
		).toEqual([three]);
		disk.go();
		await whenRefreshed(dir);

		expect(
			treesHeldBy("s-1", dir).sort(),
			"a reading that started before them doesn't undo them",
		).toEqual([three, two]);
		await whenRefreshed(dir);
		expect(treesHeldBy("s-1", dir).sort(), "nor does the next").toEqual([
			three,
			two,
		]);
	});

	it("keep the last listing when a reading off the thread fails, until the folder changes again", async () => {
		const root = mkdtempSync(join(tmpdir(), "records-"));
		const dir = join(root, "cut");
		const one = join(root, "trees", "one");
		const two = join(root, "trees", "two");
		const three = join(root, "trees", "three");
		recorded(dir, one, ["s-1"]);
		settled(dir);
		expect(treesHeldBy("s-1", dir)).toEqual([one]);

		disk.failing = true;
		recordedElsewhere(dir, two, ["s-1"]);
		treesHeldBy("s-1", dir);
		await whenRefreshed(dir);
		const tried = disk.listingsOf(dir);
		expect(
			treesHeldBy("s-1", dir),
			"a failed reading is never swapped in, empty or otherwise",
		).toEqual([one]);
		await whenRefreshed(dir);
		expect(
			disk.listingsOf(dir),
			"the folder as it failed isn't read again at every call",
		).toBe(tried);

		disk.failing = false;
		recordedElsewhere(dir, three, ["s-1"]);
		treesHeldBy("s-1", dir);
		await whenRefreshed(dir);
		expect(treesHeldBy("s-1", dir).sort()).toEqual([one, three, two]);
	});

	it("read the folder again a minute after a reading fails, though it stands as it failed", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const root = mkdtempSync(join(tmpdir(), "records-"));
		const dir = join(root, "cut");
		const one = join(root, "trees", "one");
		const two = join(root, "trees", "two");
		recorded(dir, one, ["s-1"]);
		settled(dir);
		expect(treesHeldBy("s-1", dir)).toEqual([one]);

		disk.failing = true;
		recordedElsewhere(dir, two, ["s-1"]);
		treesHeldBy("s-1", dir);
		await whenRefreshed(dir);
		disk.failing = false;
		const tried = disk.listingsOf(dir);
		treesHeldBy("s-1", dir);
		await whenRefreshed(dir);
		expect(disk.listingsOf(dir), "not read again at once").toBe(tried);
		expect(treesHeldBy("s-1", dir)).toEqual([one]);

		vi.setSystemTime(Date.now() + 61_000);
		treesHeldBy("s-1", dir);
		await whenRefreshed(dir);
		expect(treesHeldBy("s-1", dir).sort()).toEqual([one, two]);
	});

	it("still drop a tree gone from the disk while their readings fail", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const root = mkdtempSync(join(tmpdir(), "records-"));
		const dir = join(root, "cut");
		const one = join(root, "trees", "one");
		const two = join(root, "trees", "two");
		const three = join(root, "trees", "three");
		recorded(dir, one, ["s-1"]);
		recorded(dir, two, ["s-1"]);
		settled(dir);
		expect(treesHeldBy("s-1", dir).sort()).toEqual([one, two]);

		const said = stderrSaid();
		disk.failing = true;
		recordedElsewhere(dir, three, ["s-1"]);
		treesHeldBy("s-1", dir);
		await whenRefreshed(dir);
		rmSync(two, { recursive: true });

		for (const _ of [1, 2]) {
			vi.setSystemTime(Date.now() + 61_000);
			treesHeldBy("s-1", dir);
			await whenRefreshed(dir);
		}

		expect(treesHeldBy("s-1", dir)).toEqual([one]);
		expect(
			said.naming(dir),
			"a folder failing at one stamp is said once",
		).toHaveLength(1);
	});

	it("fail a reading off the thread that can't read a record, rather than swap in one without it", async () => {
		const root = mkdtempSync(join(tmpdir(), "records-"));
		const dir = join(root, "cut");
		const one = join(root, "trees", "one");
		const two = join(root, "trees", "two");
		recorded(dir, one, ["s-1"]);
		settled(dir);
		expect(treesHeldBy("s-1", dir)).toEqual([one]);

		recorded(dir, two, ["s-1"]);
		disk.unreadable = recordOf(dir, two);
		treesHeldBy("s-1", dir);
		await whenRefreshed(dir);

		expect(
			treesHeldBy("s-1", dir).sort(),
			"this process's cut still shows",
		).toEqual([one, two]);
	});

	// The council on #1962: a record re-cut at the same key while a
	// reading off the thread waits must not be removed by it.
	it("leave a record whose tree is gone for the reading on the thread to remove", async () => {
		const root = mkdtempSync(join(tmpdir(), "records-"));
		const dir = join(root, "cut");
		const one = join(root, "trees", "one");
		const two = join(root, "trees", "two");
		recorded(dir, one, ["s-1"]);
		settled(dir);
		expect(treesHeldBy("s-1", dir)).toEqual([one]);
		const record = recordOf(dir, one);

		rmSync(one, { recursive: true });
		recordedElsewhere(dir, two, ["s-1"]);
		treesHeldBy("s-1", dir);
		await whenRefreshed(dir);

		expect(treesHeldBy("s-1", dir)).toEqual([two]);
		expect(
			existsSync(record),
			"the reading off the thread removes nothing",
		).toBe(true);
		createTreeMemory(dir).recall();
		expect(existsSync(record), "the reading on the thread does").toBe(false);
	});

	it("drop at once a tree this process cut and then took by its key or pruned", async () => {
		const root = mkdtempSync(join(tmpdir(), "records-"));
		const dir = join(root, "cut");
		const one = join(root, "trees", "one");
		const two = join(root, "trees", "two");
		const three = join(root, "trees", "three");
		recorded(dir, one, ["s-1"]);
		settled(dir);
		expect(treesHeldBy("s-1", dir)).toEqual([one]);
		recorded(dir, two, ["s-1"]);
		recorded(dir, three, ["s-1"]);

		const taken = await createTreeMemory(dir).whileUnusedSince(
			two,
			Date.now() + 60_000,
			async () => true,
			two.replaceAll("/", "-"),
		);
		expect(taken?.path, "the sweep took it").toBe(two);
		rmSync(three, { recursive: true });
		createTreeMemory(dir).recall();

		expect(treesHeldBy("s-1", dir)).toEqual([one]);
	});

	it("answer a caller that asks once with another process's cut, read off the thread first", async () => {
		const root = mkdtempSync(join(tmpdir(), "records-"));
		const dir = join(root, "cut");
		const one = join(root, "trees", "one");
		const two = join(root, "trees", "two");
		recorded(dir, one, ["s-1"]);
		settled(dir);
		expect(treesHeldBy("s-1", dir)).toEqual([one]);

		recordedElsewhere(dir, two, ["s-1"]);

		expect((await treesHeldByNow("s-1", dir)).sort()).toEqual([one, two]);
	});

	it("show a cut made through another copy of the modules, as a reloaded conversation holds", async () => {
		const root = mkdtempSync(join(tmpdir(), "records-"));
		const dir = join(root, "cut");
		const one = join(root, "trees", "one");
		const two = join(root, "trees", "two");
		recorded(dir, one, ["s-1"]);
		settled(dir);
		expect(treesHeldBy("s-1", dir)).toEqual([one]);

		vi.resetModules();
		const other = await import("../../../lib/core/work/memory.ts");
		const otherRecords = await import("../../../lib/internal/work-records.ts");
		mkdirSync(two, { recursive: true });
		other.createTreeMemory(dir).remember({
			identity: { key: two.replaceAll("/", "-"), shareable: false },
			path: two,
			providerId: "git",
			sessions: ["s-1"],
		});

		expect(treesHeldBy("s-1", dir).sort()).toEqual([one, two]);
		expect(otherRecords.treesHeldBy("s-1", dir).sort()).toEqual([one, two]);
	});

	it("are read off the thread once at a time for the process", async () => {
		const root = mkdtempSync(join(tmpdir(), "records-"));
		const dir = join(root, "cut");
		const one = join(root, "trees", "one");
		const two = join(root, "trees", "two");
		const three = join(root, "trees", "three");
		recorded(dir, one, ["s-1"]);
		settled(dir);
		expect(treesHeldBy("s-1", dir)).toEqual([one]);

		disk.stop(root);
		recordedElsewhere(dir, two, ["s-1"]);
		const before = disk.listingsOf(dir);
		treesHeldBy("s-1", dir);
		await disk.stopped();
		recordedElsewhere(dir, three, ["s-1"]);
		treesHeldBy("s-1", dir);
		treesHeldBy("s-2", dir);
		await answered();
		expect(
			disk.listingsOf(dir) - before,
			"a change while one reading runs starts no second",
		).toBe(1);
		disk.go();
		await whenRefreshed(dir);
		expect(treesHeldBy("s-1", dir).sort()).toEqual([one, two]);

		await whenRefreshed(dir);
		expect(
			treesHeldBy("s-1", dir).sort(),
			"the change it missed is read by the next",
		).toEqual([one, three, two]);
	});

	// 1DZYLJ, 21 November: the sweep reads the one record it takes from disk.
	it("leave the sweep's take reading its record from disk, never the kept listing", async () => {
		const root = mkdtempSync(join(tmpdir(), "records-"));
		const dir = join(root, "cut");
		const one = join(root, "trees", "one");
		recorded(dir, one, ["s-1"]);
		settled(dir);
		expect(treesHeldBy("s-1", dir)).toEqual([one]);
		const key = one.replaceAll("/", "-");

		rmSync(recordOf(dir, one));
		let took = false;
		const taken = await createTreeMemory(dir).whileUnusedSince(
			one,
			Date.now(),
			async () => {
				took = true;
				return true;
			},
			key,
		);

		expect({ taken, took }).toEqual({ taken: undefined, took: false });
	});

	it("aren't changed for the next caller by what one caller does with them", () => {
		const root = mkdtempSync(join(tmpdir(), "records-"));
		const dir = join(root, "cut");
		const one = join(root, "trees", "one");
		recorded(dir, one, ["s-1"]);
		settled(dir);

		recordedTrees(dir).length = 0;

		expect(treesHeldBy("s-1", dir)).toEqual([one]);
	});

	it("pass over a record that won't parse, as they always have", () => {
		const root = mkdtempSync(join(tmpdir(), "records-"));
		const dir = join(root, "cut");
		const one = join(root, "trees", "one");
		recorded(dir, one, ["s-1"]);
		const torn = join(root, "torn.json");
		writeFileSync(torn, "{ not json");
		renameSync(torn, join(dir, "torn.json"));

		expect(treesHeldBy("s-1", dir)).toEqual([one]);
		expect(
			readdirSync(dir).includes("torn.json"),
			"a record that won't parse is left where it is",
		).toBe(true);
	});

	// The second council on #1962: both readers judge a record that won't
	// read the same way, so neither freezes on one that never will.
	it("pass over a record that fails to read for its own sake, read on the thread or off it", async () => {
		const root = mkdtempSync(join(tmpdir(), "records-"));
		const dir = join(root, "cut");
		const one = join(root, "trees", "one");
		const two = join(root, "trees", "two");
		recorded(dir, one, ["s-1"]);
		mkdirSync(join(dir, "a-folder.json"));
		settled(dir);
		expect(treesHeldBy("s-1", dir)).toEqual([one]);

		recordedElsewhere(dir, two, ["s-1"]);
		treesHeldBy("s-1", dir);
		await whenRefreshed(dir);

		expect(
			treesHeldBy("s-1", dir).sort(),
			"a folder named as a record freezes no reading",
		).toEqual([one, two]);
	});

	it("answer none from a first reading the disk fails for now, keeping nothing of it", () => {
		const root = mkdtempSync(join(tmpdir(), "records-"));
		const dir = join(root, "cut");
		const one = join(root, "trees", "one");
		recorded(dir, one, ["s-1"]);
		settled(dir);
		const said = stderrSaid();

		disk.unreadableOnThread = recordOf(dir, one);
		expect(treesHeldBy("s-1", dir), "it grants nothing").toEqual([]);
		expect(said.naming(dir), "and says why").toHaveLength(1);
		disk.unreadableOnThread = undefined;

		expect(
			treesHeldBy("s-1", dir),
			"the next call reads them again, nothing kept from the failure",
		).toEqual([one]);
	});

	it("fail the broker's own reading on a record the disk fails to hand over for now", () => {
		const root = mkdtempSync(join(tmpdir(), "records-"));
		const dir = join(root, "cut");
		const one = join(root, "trees", "one");
		recorded(dir, one, ["s-1"]);

		disk.unreadableOnThread = recordOf(dir, one);

		expect(
			() => createTreeMemory(dir).recall(),
			"rather than rewrite a record without the holders it couldn't read",
		).toThrow(/EMFILE/);
	});

	it("stop reading a folder's other records once one fails the reading", async () => {
		const root = mkdtempSync(join(tmpdir(), "records-"));
		const dir = join(root, "cut");
		const one = join(root, "trees", "one");
		recorded(dir, one, ["s-1"]);
		settled(dir);
		expect(treesHeldBy("s-1", dir)).toEqual([one]);
		for (let made = 0; made < 40; made += 1) {
			recordedElsewhere(dir, join(root, "trees", `t${made}`), ["s-2"]);
		}
		const first = readdirSync(dir).find((name) => name.endsWith(".json"));
		disk.unreadable = join(dir, first ?? "");

		treesHeldBy("s-1", dir);
		await whenRefreshed(dir);
		await answered();

		expect(
			disk.reads.filter((read) => read.startsWith(dir)).length,
			"no lane takes another record once one failed",
		).toBeLessThanOrEqual(16);
	});

	it("read a failed folder again only a minute on, though its trees are looked for meanwhile", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const root = mkdtempSync(join(tmpdir(), "records-"));
		const dir = join(root, "cut");
		const one = join(root, "trees", "one");
		const two = join(root, "trees", "two");
		recorded(dir, one, ["s-1"]);
		settled(dir);
		const start = Date.now();
		expect(treesHeldBy("s-1", dir)).toEqual([one]);
		const said = stderrSaid();

		vi.setSystemTime(start + 30_000);
		disk.failing = true;
		recordedElsewhere(dir, two, ["s-1"]);
		treesHeldBy("s-1", dir);
		await whenRefreshed(dir);
		vi.setSystemTime(start + 61_000);
		treesHeldBy("s-1", dir);
		await whenRefreshed(dir);
		const tried = disk.listingsOf(dir);
		vi.setSystemTime(start + 62_000);
		treesHeldBy("s-1", dir);
		await whenRefreshed(dir);

		expect(
			disk.listingsOf(dir),
			"looking for its trees isn't a reading that cleared the failure",
		).toBe(tried);
		expect(said.naming(dir), "said once").toHaveLength(1);
	});

	it("answer a caller that asks once from a reading begun after it asked, when one under way predates a cut", async () => {
		const root = mkdtempSync(join(tmpdir(), "records-"));
		const dir = join(root, "cut");
		const one = join(root, "trees", "one");
		const two = join(root, "trees", "two");
		const three = join(root, "trees", "three");
		recorded(dir, one, ["s-1"]);
		settled(dir);
		expect(treesHeldBy("s-1", dir)).toEqual([one]);

		disk.stop(root);
		recordedElsewhere(dir, two, ["s-1"]);
		treesHeldBy("s-1", dir);
		await disk.stopped();
		recordedElsewhere(dir, three, ["s-1"]);
		const asked = treesHeldByNow("s-1", dir);
		disk.go();

		expect((await asked).sort()).toEqual([one, three, two]);
	});

	it("answer a caller that asks once from a reading begun after it asked, when a write shares the stamp of the one under way", async () => {
		const root = mkdtempSync(join(tmpdir(), "records-"));
		const dir = join(root, "cut");
		const one = join(root, "trees", "one");
		const two = join(root, "trees", "two");
		const three = join(root, "trees", "three");
		recorded(dir, one, ["s-1"]);
		recordedElsewhere(dir, two, ["s-2"]);
		settled(dir);
		expect(treesHeldBy("s-1", dir)).toEqual([one]);

		disk.stop(root);
		const tick = recordedElsewhere(dir, three, ["s-1"]);
		treesHeldBy("s-1", dir);
		await disk.stopped();
		replaceInTheSameTick(recordOf(dir, two), ["s-1", "s-2"], tick);
		const asked = treesHeldByNow("s-1", dir);
		disk.go();

		expect(
			(await asked).sort(),
			"a tree taken up in the tick the reading under way began in",
		).toEqual([one, three, two]);
	});

	it("read a folder a reading failed on again once a write sharing its tick is old enough", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		stderrSaid();
		const root = mkdtempSync(join(tmpdir(), "records-"));
		const dir = join(root, "cut");
		const one = join(root, "trees", "one");
		const two = join(root, "trees", "two");
		const three = join(root, "trees", "three");
		recorded(dir, one, ["s-1"]);
		recordedElsewhere(dir, two, ["s-2"]);
		settled(dir);
		expect(treesHeldBy("s-1", dir)).toEqual([one]);

		disk.failing = true;
		const tick = recordedElsewhere(dir, three, ["s-1"]);
		treesHeldBy("s-1", dir);
		await whenRefreshed(dir);
		replaceInTheSameTick(recordOf(dir, two), ["s-1", "s-2"], tick);
		disk.failing = false;
		vi.setSystemTime(Date.now() + 3_001);
		treesHeldBy("s-1", dir);
		await whenRefreshed(dir);

		expect(
			treesHeldBy("s-1", dir).sort(),
			"seen within the racy window, not a minute on",
		).toEqual([one, three, two]);
	});

	it("refuse a caller that asks once when the reading it waits on fails, rather than answer stale", async () => {
		const root = mkdtempSync(join(tmpdir(), "records-"));
		const dir = join(root, "cut");
		const one = join(root, "trees", "one");
		const two = join(root, "trees", "two");
		recorded(dir, one, ["s-1"]);
		settled(dir);
		expect(treesHeldBy("s-1", dir)).toEqual([one]);

		disk.failing = true;
		recordedElsewhere(dir, two, ["s-1"]);

		await expect(treesHeldByNow("s-1", dir)).rejects.toThrow(
			/couldn't be read/,
		);
	});

	it("read at once for a caller that asks once, though a failed reading waits out its minute", async () => {
		const root = mkdtempSync(join(tmpdir(), "records-"));
		const dir = join(root, "cut");
		const one = join(root, "trees", "one");
		const two = join(root, "trees", "two");
		recorded(dir, one, ["s-1"]);
		settled(dir);
		expect(treesHeldBy("s-1", dir)).toEqual([one]);
		disk.failing = true;
		recordedElsewhere(dir, two, ["s-1"]);
		treesHeldBy("s-1", dir);
		await whenRefreshed(dir);

		disk.failing = false;

		expect((await treesHeldByNow("s-1", dir)).sort()).toEqual([one, two]);
	});

	it.skipIf(asRoot)(
		"refuse a caller that asks once while their folder can't be looked at",
		async () => {
			const root = mkdtempSync(join(tmpdir(), "records-"));
			const dir = join(root, "cut");
			const one = join(root, "trees", "one");
			recorded(dir, one, ["s-1"]);
			settled(dir);
			expect(treesHeldBy("s-1", dir)).toEqual([one]);

			chmodSync(root, 0o000);
			try {
				await expect(treesHeldByNow("s-1", dir)).rejects.toThrow(
					/can't be looked at/,
				);
			} finally {
				chmodSync(root, 0o700);
			}
		},
	);

	it("look on disk only for the trees a caller that asks once holds", async () => {
		const root = mkdtempSync(join(tmpdir(), "records-"));
		const dir = join(root, "cut");
		const one = join(root, "trees", "one");
		const two = join(root, "trees", "two");
		const three = join(root, "trees", "three");
		recorded(dir, one, ["s-1"]);
		recorded(dir, two, ["s-2"]);
		recorded(dir, three, ["s-2", "s-3"]);
		settled(dir);
		disk.looked.length = 0;

		expect(await treesHeldByNow("s-1", dir)).toEqual([one]);

		expect(
			disk.looked.filter((path) => path.startsWith(root)),
			"no other session's tree is looked for",
		).toEqual([one]);
	});

	it("answer a caller that asks once while the shared reading is stuck looking for another session's tree", async () => {
		const root = mkdtempSync(join(tmpdir(), "records-"));
		const dir = join(root, "cut");
		const one = join(root, "trees", "one");
		const two = join(root, "trees", "two");
		const three = join(root, "trees", "three");
		recorded(dir, one, ["s-1"]);
		settled(dir);
		expect(treesHeldBy("s-1", dir)).toEqual([one]);

		disk.stop(two);
		recordedElsewhere(dir, two, ["s-2"]);
		treesHeldBy("s-1", dir);
		await disk.stopped();
		recordedElsewhere(dir, three, ["s-1"]);

		expect(
			(await treesHeldByNow("s-1", dir, 5_000)).sort(),
			"read afresh, not after the stuck one",
		).toEqual([one, three]);
		disk.go();
		await whenRefreshed(dir);
	});

	it("refuse a caller that asks once when its reading doesn't land in time", async () => {
		const root = mkdtempSync(join(tmpdir(), "records-"));
		const dir = join(root, "cut");
		const one = join(root, "trees", "one");
		const two = join(root, "trees", "two");
		recorded(dir, one, ["s-1"]);
		settled(dir);
		expect(treesHeldBy("s-1", dir)).toEqual([one]);

		disk.stop(root);
		recordedElsewhere(dir, two, ["s-1"]);
		treesHeldBy("s-1", dir);
		await disk.stopped();

		await expect(treesHeldByNow("s-1", dir, 50)).rejects.toThrow(/in 50 ms/);
		disk.go();
		await whenRefreshed(dir);
	});

	it("list a folder that never holds still again by name, reading each record once and keeping all", async () => {
		const root = mkdtempSync(join(tmpdir(), "records-"));
		const dir = join(root, "cut");
		const one = join(root, "trees", "one");
		recorded(dir, one, ["s-1"]);
		const written: string[] = [];
		// Each listing finds the folder written since its stamp was taken,
		// as a busy machine's sessions write it every few seconds.
		disk.onList = (listed) => {
			if (listed !== dir) return;
			const more = join(root, "trees", `more-${written.length}`);
			written.push(more);
			recordedElsewhere(dir, more, ["s-2"]);
		};

		const trees = (await recallOff(dir)).map((tree) => tree.path);
		const readHere = disk.reads.filter((at) => at.startsWith(`${dir}/`));

		// Listed as many times as LISTING_TRIES allows, eight.
		expect(disk.listingsOf(dir)).toBe(8);
		expect(readHere.length).toBe(new Set(readHere).size);
		expect(trees.sort()).toEqual([one, ...written].sort());
	});

	it("keep a record a later listing left out while the folder moved, as btrfs did beside a rename", async () => {
		const root = mkdtempSync(join(tmpdir(), "records-"));
		const dir = join(root, "cut");
		const one = join(root, "trees", "one");
		recorded(dir, one, ["s-1"]);
		const name = basename(recordOf(dir, one));
		let listings = 0;
		disk.onList = (listed) => {
			if (listed !== dir) return;
			listings += 1;
			recordedElsewhere(dir, join(root, "trees", `more-${listings}`), ["s-2"]);
			if (listings === 2) disk.hidden.add(name);
		};

		const trees = (await recallOff(dir)).map((tree) => tree.path);
		const more = Array.from({ length: 8 }, (_, at) =>
			join(root, "trees", `more-${at + 1}`),
		);

		expect(listings).toBe(8);
		expect(trees.sort()).toEqual([one, ...more].sort());
	});

	it("keep a record a later listing left out on the thread too", () => {
		const root = mkdtempSync(join(tmpdir(), "records-"));
		const dir = join(root, "cut");
		const one = join(root, "trees", "one");
		recorded(dir, one, ["s-1"]);
		const name = basename(recordOf(dir, one));
		let listings = 0;
		disk.onList = (listed) => {
			if (listed !== dir) return;
			listings += 1;
			recordedElsewhere(dir, join(root, "trees", `more-${listings}`), ["s-2"]);
			if (listings === 2) disk.hidden.add(name);
		};

		// The hidden record's tree stays on disk, so recall keeps its record.
		const trees = createTreeMemory(dir)
			.recall()
			.map((tree) => tree.path);
		const more = Array.from({ length: 8 }, (_, at) =>
			join(root, "trees", `more-${at + 1}`),
		);

		expect(listings).toBe(8);
		expect(trees.sort()).toEqual([one, ...more].sort());
	});

	it("read again a name that held no record when first read, once a later listing names it", async () => {
		const { dir, x, half } = halfWritten();

		const trees = (await recallOff(dir)).map((tree) => tree.path);

		expect(half.listings).toBe(3);
		expect(trees).toContain(x);
	});

	it("answer a settled reading from its last listing, leaving out a record removed before it", async () => {
		const { dir, a, one } = removedMidway();

		const trees = (await recallOff(dir)).map((tree) => tree.path);

		expect(trees).toContain(one);
		expect(trees).not.toContain(a);
	});

	it("answer a settled reading on the thread from its last listing too", () => {
		const { dir, a, one } = removedMidway();

		const trees = createTreeMemory(dir)
			.recall()
			.map((tree) => tree.path);

		expect(trees).toContain(one);
		expect(trees).not.toContain(a);
	});

	it("name a holder a moving reading went past", async () => {
		const root = mkdtempSync(join(tmpdir(), "records-"));
		const dir = join(root, "cut");
		const one = join(root, "trees", "one");
		recorded(dir, one);
		const record = recordOf(dir, one);
		const startedAt = 1_760_000_000_000;
		const other = { pid: 4242, startedAt };
		let listings = 0;
		// The first listing's read finds nobody; the second listing finds
		// the record renamed over with a session that took the tree up.
		disk.onList = (listed) => {
			if (listed !== dir) return;
			listings += 1;
			if (listings === 1)
				recordedElsewhere(dir, join(root, "trees", "more-1"), ["s-2"]);
			if (listings === 2) {
				const held = JSON.parse(readFileSync(record, "utf8"));
				const staged = `${record}.staged`;
				writeFileSync(staged, JSON.stringify({ ...held, owners: [other] }));
				renameSync(staged, record);
				recordedElsewhere(dir, join(root, "trees", "more-2"), ["s-2"]);
			}
		};
		const facts = { alive: () => true, startedAt: async () => startedAt };

		const others = await createTreeMemory(dir).otherHolders(one, facts);

		expect(listings).toBe(3);
		expect(others).toEqual([other]);
	});

	it("refuse to judge a tree's holders when its own record can't be read again", async () => {
		const root = mkdtempSync(join(tmpdir(), "records-"));
		const dir = join(root, "cut");
		const one = join(root, "trees", "one");
		recorded(dir, one);
		const record = recordOf(dir, one);
		let listings = 0;
		// Read once while the folder moves, then out of descriptors by the
		// time its own record is read again.
		disk.onList = (listed) => {
			if (listed !== dir) return;
			listings += 1;
			if (listings === 1)
				recordedElsewhere(dir, join(root, "trees", "more"), ["s-2"]);
			if (listings === 2) disk.unreadableOnThread = record;
		};
		const facts = { alive: () => true, startedAt: async () => 1 };

		await expect(
			createTreeMemory(dir).otherHolders(one, facts),
			"a release must not judge from the first read",
		).rejects.toThrow(/EMFILE/);
	});

	it("read again on the thread a name that held no record when first read", () => {
		const { dir, x, half } = halfWritten();

		const trees = createTreeMemory(dir)
			.recall()
			.map((tree) => tree.path);

		expect(half.listings).toBe(3);
		expect(trees).toContain(x);
	});

	it("list a moving folder again by name on the thread too, reading each record once", () => {
		const root = mkdtempSync(join(tmpdir(), "records-"));
		const dir = join(root, "cut");
		const one = join(root, "trees", "one");
		recorded(dir, one, ["s-1"]);
		const written: string[] = [];
		disk.onList = (listed) => {
			if (listed !== dir) return;
			const more = join(root, "trees", `more-${written.length}`);
			written.push(more);
			recordedElsewhere(dir, more, ["s-2"]);
		};
		const before = disk.readsOnThread.length;

		const trees = createTreeMemory(dir)
			.recall()
			.map((tree) => tree.path);
		const readHere = disk.readsOnThread
			.slice(before)
			.filter((at) => at.startsWith(`${dir}/`));

		// Listed as many times as LISTING_TRIES allows, eight.
		expect(disk.listedOnThread.filter((one) => one === dir).length).toBe(8);
		expect(readHere.length).toBe(new Set(readHere).size);
		expect(trees.sort()).toEqual([one, ...written].sort());
	});

	it("let go of a reading hung five minutes, start another, and keep the newer whichever lands last", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const root = mkdtempSync(join(tmpdir(), "records-"));
		const dir = join(root, "cut");
		const one = join(root, "trees", "one");
		const two = join(root, "trees", "two");
		const three = join(root, "trees", "three");
		recorded(dir, one, ["s-1"]);
		settled(dir);
		expect(treesHeldBy("s-1", dir)).toEqual([one]);
		disk.stop(root);
		recordedElsewhere(dir, two, ["s-1"]);
		treesHeldBy("s-1", dir);
		await disk.stopped();
		const said = stderrSaid();

		vi.setSystemTime(Date.now() + 5 * 60_000 + 1_000);
		recordedElsewhere(dir, three, ["s-1"]);
		const before = disk.listingsOf(dir);
		treesHeldBy("s-1", dir);
		await answered();
		expect(disk.listingsOf(dir) - before, "another reading started").toBe(1);
		expect(said.naming(dir), "the hung one said").toHaveLength(1);

		disk.go();
		await whenRefreshed(dir);
		await answered();
		expect(treesHeldBy("s-1", dir).sort()).toEqual([one, three, two]);
	});

	it("swap nothing into a folder made again from a reading begun before it went", async () => {
		const root = mkdtempSync(join(tmpdir(), "records-"));
		const dir = join(root, "cut");
		const one = join(root, "trees", "one");
		const two = join(root, "trees", "two");
		const three = join(root, "trees", "three");
		recorded(dir, one, ["s-1"]);
		settled(dir);
		expect(treesHeldBy("s-1", dir)).toEqual([one]);
		disk.stop(root);
		recordedElsewhere(dir, two, ["s-1"]);
		treesHeldBy("s-1", dir);
		await disk.stopped();

		rmSync(dir, { recursive: true });
		expect(treesHeldBy("s-1", dir), "a folder gone holds nothing").toEqual([]);
		mkdirSync(dir);
		recordedElsewhere(dir, three, ["s-1"]);
		settled(dir);
		expect(treesHeldBy("s-1", dir), "made again, read afresh").toEqual([three]);
		disk.go();
		await whenRefreshed(dir);
		await answered();

		expect(
			treesHeldBy("s-1", dir),
			"the reading begun before it went swaps in nothing",
		).toEqual([three]);
	});

	// Joel, 8 November: trees agents cut are trusted by default.
	it("tell a folder in a tree the broker cut from one beside it", () => {
		const root = mkdtempSync(join(tmpdir(), "records-"));
		const dir = join(root, "cut");
		const tree = join(root, "trees", "one");
		recorded(dir, tree);
		mkdirSync(join(tree, "src"), { recursive: true });
		mkdirSync(join(root, "trees", "one-more"), { recursive: true });

		const cut = [tree, join(tree, "src")].filter(
			(folder) => !isAgentCut(folder, dir),
		);
		const beside = [join(root, "trees", "one-more"), root].filter((folder) =>
			isAgentCut(folder, dir),
		);
		expect(cut, "every folder in the cut tree counts").toEqual([]);
		expect(beside, "no folder outside it counts").toEqual([]);
	});
});

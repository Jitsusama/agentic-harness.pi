/**
 * The work broker's records, read for the trees each session holds.
 */
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTreeMemory } from "../../../lib/core/work/memory.ts";
import {
	isAgentCut,
	recordedTrees,
	treesHeldBy,
	whenRefreshed,
} from "../../../lib/internal/work-records.ts";

/**
 * The disk as a reading off the thread sees it, which a test can stop
 * just after the records are read, while their trees are looked for,
 * and make fail.
 */
const disk = vi.hoisted(() => {
	let held: Promise<void> | undefined;
	let release = (): void => {};
	let reach = (): void => {};
	let reached: Promise<void> = Promise.resolve();
	return {
		/** How many times a folder of records was listed off the thread. */
		listings: 0,
		/** Whether the next listings off the thread fail. */
		failing: false,
		/** Stop the next reading where it looks for its trees. */
		stop(): void {
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
			release();
		},
		async pass(): Promise<void> {
			if (held === undefined) return;
			reach();
			await held;
		},
	};
});

vi.mock("node:fs/promises", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:fs/promises")>();
	const readdir = (async (...args: Parameters<typeof real.readdir>) => {
		disk.listings += 1;
		if (disk.failing) throw new Error("EMFILE: too many open files");
		return real.readdir(...args);
	}) as typeof real.readdir;
	const access = async (...args: Parameters<typeof real.access>) => {
		await disk.pass();
		return real.access(...args);
	};
	const mocked = { ...real, readdir, access };
	return { ...mocked, default: mocked };
});

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

/**
 * A record of a tree at `path` held by `sessions`, written as another
 * process writes one: beside the folder and renamed in, so this
 * process's own writes don't know of it.
 */
function recordedElsewhere(
	dir: string,
	path: string,
	sessions: string[],
): void {
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
}

/** `dir` as last written a while ago, so a listing of it is settled. */
function settled(dir: string): void {
	const while_ago = new Date(Date.now() - 10_000);
	utimesSync(dir, while_ago, while_ago);
}

describe("the work broker's records", () => {
	afterEach(() => {
		vi.useRealTimers();
		disk.go();
		disk.failing = false;
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

	it("are read again once a record is written into their folder", () => {
		const root = mkdtempSync(join(tmpdir(), "records-"));
		const dir = join(root, "cut");
		const one = join(root, "trees", "one");
		const two = join(root, "trees", "two");
		recorded(dir, one, ["s-1"]);
		settled(dir);
		expect(treesHeldBy("s-1", dir)).toEqual([one]);

		recorded(dir, two, ["s-1"]);

		expect(treesHeldBy("s-1", dir).sort()).toEqual([one, two]);
	});

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

		disk.stop();
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
		const tried = disk.listings;
		expect(
			treesHeldBy("s-1", dir),
			"a failed reading is never swapped in, empty or otherwise",
		).toEqual([one]);
		await whenRefreshed(dir);
		expect(
			disk.listings,
			"the folder as it failed isn't read again at every call",
		).toBe(tried);

		disk.failing = false;
		recordedElsewhere(dir, three, ["s-1"]);
		treesHeldBy("s-1", dir);
		await whenRefreshed(dir);
		expect(treesHeldBy("s-1", dir).sort()).toEqual([one, three, two]);
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

		disk.stop();
		recordedElsewhere(dir, two, ["s-1"]);
		const before = disk.listings;
		treesHeldBy("s-1", dir);
		await disk.stopped();
		recordedElsewhere(dir, three, ["s-1"]);
		treesHeldBy("s-1", dir);
		treesHeldBy("s-2", dir);
		expect(
			disk.listings - before,
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

		expect(treesHeldBy("s-1", dir), "the kept listing still names it").toEqual(
			[one],
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

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
} from "../../../lib/internal/work-records.ts";

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

/** `dir` as last written a while ago, so a listing of it is settled. */
function settled(dir: string): void {
	const while_ago = new Date(Date.now() - 10_000);
	utimesSync(dir, while_ago, while_ago);
}

describe("the work broker's records", () => {
	afterEach(() => {
		vi.useRealTimers();
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
		expect(treesHeldBy("s-1", dir)).toEqual([one]);

		recorded(dir, two, ["s-1"]);

		expect(treesHeldBy("s-1", dir).sort()).toEqual([one, two]);
	});

	// Git calls such an index entry racily clean.
	it("aren't kept from a read made just after their folder was written", () => {
		const root = mkdtempSync(join(tmpdir(), "records-"));
		const dir = join(root, "cut");
		const one = join(root, "trees", "one");
		recorded(dir, one, ["s-1"]);
		const tick = new Date(Math.floor(Date.now()));
		utimesSync(dir, tick, tick);
		const stamp = statSync(dir).mtimeMs;
		expect(treesHeldBy("s-1", dir)).toEqual([one]);

		replaceInTheSameTick(recordOf(dir, one), ["s-2"], tick);
		expect(statSync(dir).mtimeMs, "the folder's time is as it was").toBe(stamp);

		expect(
			treesHeldBy("s-2", dir),
			"a record replaced in the tick its listing was read in is read",
		).toEqual([one]);
	});

	it("drop a tree gone from the disk within a minute, its record left", () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const root = mkdtempSync(join(tmpdir(), "records-"));
		const dir = join(root, "cut");
		const one = join(root, "trees", "one");
		const two = join(root, "trees", "two");
		recorded(dir, one, ["s-1"]);
		recorded(dir, two, ["s-1"]);
		expect(treesHeldBy("s-1", dir).sort()).toEqual([one, two]);

		rmSync(one, { recursive: true });
		vi.setSystemTime(Date.now() + 61_000);

		expect(treesHeldBy("s-1", dir)).toEqual([two]);
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

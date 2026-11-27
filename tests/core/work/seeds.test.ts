/**
 * Trees cut from a seed, against a real git, with a copy that keeps
 * times standing in for btrfs's snapshot: the git steps are what can go
 * wrong here, and a machine without btrfs can run them all.
 */

import { execFile } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Exec } from "../../../lib/core/exec/index.ts";
import { createGitTreeProvider } from "../../../lib/core/work/providers/git.ts";
import {
	SEED_FRESH_MS,
	type Snapshot,
	seedsAt,
} from "../../../lib/core/work/providers/seeds.ts";
import { disposeRepo, freshRepo, git } from "../../support/git-fixture.ts";

/** Real git, and a `btrfs subvolume create` that makes a plain folder. */
const calls: string[][] = [];
const exec: Exec = async (command, args) => {
	calls.push([command, ...args]);
	if (command === "btrfs" && args[1] === "create") {
		mkdirSync(args[2] ?? "", { recursive: true });
		return { code: 0, stdout: "", stderr: "" };
	}
	try {
		const { stdout, stderr } = await promisify(execFile)(command, [...args]);
		return { code: 0, stdout, stderr };
	} catch (error) {
		const e = error as { code?: number; stdout?: string; stderr?: string };
		return {
			code: typeof e.code === "number" ? e.code : 1,
			stdout: e.stdout ?? "",
			stderr: e.stderr ?? "",
		};
	}
};

/** A snapshot as btrfs takes one: every file, with its times. */
const copy: Snapshot = async (_exec, from, to) => {
	cpSync(from, to, { recursive: true, preserveTimestamps: true });
	return true;
};

let repo: string;
let work: string;
let first: string;
let second: string;
let third: string;

beforeEach(async () => {
	calls.length = 0;
	repo = await freshRepo("seeds");
	// Its real path, as git names it, where temp sits behind a link.
	work = realpathSync(mkdtempSync(join(tmpdir(), "seeds-work-")));
	for (let n = 0; n < 30; n += 1)
		writeFileSync(join(repo, `f${n}.txt`), `${n}\n`);
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", "thirty");
	first = await git(repo, "rev-parse", "HEAD");
	writeFileSync(join(repo, "f1.txt"), "changed\n");
	rmSync(join(repo, "f2.txt"));
	writeFileSync(join(repo, "new.txt"), "new\n");
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", "three");
	second = await git(repo, "rev-parse", "HEAD");
	writeFileSync(join(repo, "f3.txt"), "later\n");
	await git(repo, "commit", "-qam", "later");
	third = await git(repo, "rev-parse", "HEAD");
});

/** Age the pointer under `dir` past {@link SEED_FRESH_MS}, as `now` reads. */
function staled(dir: string, now: number): void {
	const pointer = readdirSync(dir).find((name) => name.endsWith(".seed")) ?? "";
	const stale = new Date(now - SEED_FRESH_MS - 1);
	utimesSync(join(dir, pointer), stale, stale);
}

afterEach(() => {
	rmSync(work, { recursive: true, force: true });
	disposeRepo(repo);
});

/** A tree cut in full at `commit`, as a cut with no seed is. */
async function fullCut(name: string, commit: string): Promise<string> {
	const path = join(work, "trees", name);
	await git(repo, "worktree", "add", "-q", "--detach", path, commit);
	return path;
}

/** An entry at `path` with nothing checked out, as a seeded cut begins. */
async function entry(name: string, ...at: string[]): Promise<string> {
	const path = join(work, "trees", name);
	await git(
		repo,
		"worktree",
		"add",
		"-q",
		"--no-checkout",
		...at.slice(0, -1),
		path,
		...at.slice(-1),
	);
	return path;
}

/**
 * A time no fill writes, set on a file the commits never change in the
 * seed, so a tree holding it at that time was copied from the seed
 * rather than filled in full.
 */
const LONG_AGO = new Date("2001-01-01T00:00:00Z");

/** Mark the seed's unchanging file as written {@link LONG_AGO}. */
function marked(seed: string | undefined): void {
	utimesSync(join(seed ?? "", "f0.txt"), LONG_AGO, LONG_AGO);
}

/** Whether the tree at `path` holds the seed's marked file as copied. */
function copied(path: string): boolean {
	return statSync(join(path, "f0.txt")).mtimeMs === LONG_AGO.getTime();
}

/** What git says differs in the tree at `path`, untracked files included. */
async function changes(path: string): Promise<string> {
	return await git(path, "status", "--porcelain", "--untracked-files=all");
}

describe("a tree cut from a seed", () => {
	it("stands clean at the commit asked for, with the seed as it was", async () => {
		const seeds = seedsAt(join(work, "seeds"), copy);
		await seeds.keep(exec, repo, await fullCut("a", first));
		const seed = seeds.current(repo);
		expect(
			seed,
			"the first cut should have been kept as the seed",
		).toBeDefined();
		marked(seed);

		const path = await entry("b", "--detach", second);
		await seeds.fill(exec, seed ?? "", path);

		expect(copied(path), "the tree should be the seed's copy").toBe(true);
		expect(await git(path, "rev-parse", "HEAD")).toBe(second);
		expect(await changes(path), "the cut should be clean").toBe("");
		expect(readFileSync(join(path, "f1.txt"), "utf8")).toBe("changed\n");
		expect(
			existsSync(join(path, "f2.txt")),
			"a file the commit dropped should be gone",
		).toBe(false);
		expect(readFileSync(join(path, "new.txt"), "utf8")).toBe("new\n");
		expect(
			await git(seed ?? "", "rev-parse", "HEAD"),
			"the seed should not move",
		).toBe(first);
		expect(await changes(seed ?? ""), "the seed should stay clean").toBe("");
	});

	it("stands clean on the new branch it was cut on", async () => {
		const seeds = seedsAt(join(work, "seeds"), copy);
		await seeds.keep(exec, repo, await fullCut("a", first));
		marked(seeds.current(repo));

		const path = await entry("b", "-b", "topic", second);
		await seeds.fill(exec, seeds.current(repo) ?? "", path);

		expect(copied(path), "the tree should be the seed's copy").toBe(true);
		expect(await git(path, "symbolic-ref", "--short", "HEAD")).toBe("topic");
		expect(await changes(path), "the cut should be clean").toBe("");
	});

	it("is filled in full when the seed can't be snapshotted", async () => {
		const seeds = seedsAt(join(work, "seeds"), copy);
		await seeds.keep(exec, repo, await fullCut("a", first));
		const refusing = seedsAt(join(work, "seeds"), async () => false);

		const path = await entry("b", "--detach", second);
		await refusing.fill(exec, seeds.current(repo) ?? "", path);

		expect(await git(path, "rev-parse", "HEAD")).toBe(second);
		expect(await changes(path), "the full fill should be clean").toBe("");
	});

	it("is filled in full when the read-tree refuses the copy", async () => {
		const seeds = seedsAt(join(work, "seeds"), copy);
		await seeds.keep(exec, repo, await fullCut("a", first));
		marked(seeds.current(repo));
		// A file the commit adds, standing untracked in the copy, makes the
		// read-tree refuse to write over it, and a stray file beside it
		// must go with the rest of the copy.
		const crowded: Snapshot = async (_exec, from, to) => {
			await copy(exec, from, to);
			writeFileSync(join(to, "new.txt"), "in the way\n");
			writeFileSync(join(to, "stray.txt"), "stray\n");
			return true;
		};

		const path = await entry("b", "--detach", second);
		await seedsAt(join(work, "seeds"), crowded).fill(
			exec,
			seeds.current(repo) ?? "",
			path,
		);

		expect(await changes(path), "the full fill should be clean").toBe("");
		expect(copied(path), "the copy should have gone for a full fill").toBe(
			false,
		);
		expect(readFileSync(join(path, "new.txt"), "utf8")).toBe("new\n");
	});
});

describe("a checkout's seed", () => {
	it("is kept once while fresh, and made anew once it isn't", async () => {
		let now = Date.now();
		const dir = join(work, "seeds");
		const seeds = seedsAt(dir, copy, () => now);
		await seeds.keep(exec, repo, await fullCut("a", first));
		const kept = seeds.current(repo);

		await seeds.keep(exec, repo, await fullCut("b", second));
		expect(seeds.current(repo), "a fresh seed should serve on").toBe(kept);

		now += SEED_FRESH_MS + 1;
		staled(dir, now);
		await seeds.keep(exec, repo, await fullCut("c", second));
		const next = seeds.current(repo);
		expect(next, "a stale seed should give way to the newer cut").not.toBe(
			kept,
		);
		expect(await git(next ?? "", "rev-parse", "HEAD")).toBe(second);
		expect(
			existsSync(kept ?? ""),
			"the seed it replaced should stand, as a cut may be copying it",
		).toBe(true);
	});

	it("goes once two newer have replaced it", async () => {
		let now = Date.now();
		const dir = join(work, "seeds");
		const seeds = seedsAt(dir, copy, () => now);
		await seeds.keep(exec, repo, await fullCut("a", first));
		const old = seeds.current(repo) ?? "";
		now += SEED_FRESH_MS + 1;
		staled(dir, now);
		await seeds.keep(exec, repo, await fullCut("b", second));
		const before = seeds.current(repo) ?? "";
		now += SEED_FRESH_MS + 1;
		staled(dir, now);
		await seeds.keep(exec, repo, await fullCut("c", third));

		expect(existsSync(old), "the oldest seed should be gone").toBe(false);
		expect(existsSync(before), "the one just replaced should stand").toBe(true);
		expect(await git(seeds.current(repo) ?? "", "rev-parse", "HEAD")).toBe(
			third,
		);
		expect(
			await git(repo, "worktree", "list"),
			"git should have no entry for it",
		).not.toContain(old);
	});

	it("isn't made from a tree whose snapshot can't be taken", async () => {
		const seeds = seedsAt(join(work, "seeds"), async () => false);
		await seeds.keep(exec, repo, await fullCut("a", first));

		expect(seeds.current(repo)).toBeUndefined();
		expect(
			await git(repo, "worktree", "list"),
			"no seed entry should stand",
		).not.toContain(join(work, "seeds"));
	});
});

describe("the git provider on btrfs", () => {
	it("cuts the second tree of a checkout from the first's seed", async () => {
		const trees = join(work, "trees");
		const provider = createGitTreeProvider({
			exec,
			stateDir: trees,
			subvolumes: async () => true,
			seeds: seedsAt(join(work, "seeds"), copy),
		});
		const ask = (commit: string) => ({
			intent: "snapshot" as const,
			repo: { key: "local:seeds", localPath: repo },
			purpose: "review",
			commit,
		});

		await provider.ensure(ask(first));
		calls.length = 0;
		const held = await provider.ensure(ask(second));

		const add = calls.find((call) => call.includes("add"));
		expect(add, "the second cut should check nothing out").toContain(
			"--no-checkout",
		);
		expect(
			calls.some((call) => call.includes("create")),
			"no empty subvolume should be made",
		).toBe(false);
		expect(await git(held.path, "rev-parse", "HEAD")).toBe(second);
		expect(await changes(held.path), "the seeded cut should be clean").toBe("");
	});
});

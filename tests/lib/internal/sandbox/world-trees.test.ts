/**
 * Which World trees a strict session writes besides its folder: a tree
 * the broker's records hold for it alone counts only where it really
 * lies inside the folder `~/world/trees` leads to, through no link
 * beneath it, and holds a `.git` file.
 *
 * Each case lays out a made-up home whose `world/trees` is a link to a
 * folder beside it, as on a room, where `~/world/trees` leads to
 * `/world/trees`, and a repository the trees are worktrees of.
 */

import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTreeMemory } from "../../../../lib/core/work/memory.ts";
import {
	sessionWorldTrees,
	worldTreesAmong,
} from "../../../../lib/internal/sandbox/world-trees.ts";

let base: string;
let home: string;
let trees: string;
let repository: string;

beforeEach(() => {
	base = realpathSync(mkdtempSync(join(tmpdir(), "world-trees-")));
	home = join(base, "home");
	trees = join(base, "world-trees");
	repository = join(base, "world.git");
	mkdirSync(join(home, "world"), { recursive: true });
	mkdirSync(trees);
	mkdirSync(join(repository, "objects"), { recursive: true });
	symlinkSync(trees, join(home, "world/trees"));
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

/** A worktree of the repository at `trees/<zone>/src`, as World cuts one. */
function worktree(zone: string): string {
	const tree = join(trees, zone, "src");
	const gitFolder = join(repository, "worktrees", zone);
	mkdirSync(tree, { recursive: true });
	mkdirSync(gitFolder, { recursive: true });
	writeFileSync(join(tree, ".git"), `gitdir: ${gitFolder}\n`);
	writeFileSync(join(gitFolder, "gitdir"), `${join(tree, ".git")}\n`);
	return tree;
}

describe("the World trees among those a session holds", () => {
	it("keeps a tree named through the home's link as it really is, with its repository", () => {
		worktree("s-one");
		expect(
			worldTreesAmong([join(home, "world/trees/s-one/src")], home),
		).toEqual([{ tree: join(trees, "s-one/src"), repository }]);
	});

	it("keeps a tree named as it really is, once however often it's named", () => {
		const tree = worktree("s-one");
		expect(
			worldTreesAmong(
				[tree, join(home, "world/trees/s-one/src"), `${tree}/`],
				home,
			),
		).toEqual([{ tree, repository }]);
	});

	it("keeps a tree whose .git file names no repository, without one", () => {
		const tree = join(trees, "s-odd/src");
		mkdirSync(tree, { recursive: true });
		writeFileSync(join(tree, ".git"), "gitdir: /nowhere\n");
		expect(worldTreesAmong([tree], home)).toEqual([{ tree }]);
	});

	it("never keeps World's trees folder itself", () => {
		writeFileSync(join(trees, ".git"), "gitdir: /nowhere\n");
		expect(worldTreesAmong([join(home, "world/trees"), trees], home)).toEqual(
			[],
		);
	});

	it("never keeps a checkout outside World's trees folder", () => {
		const outside = join(base, "elsewhere/src");
		mkdirSync(outside, { recursive: true });
		writeFileSync(join(outside, ".git"), "gitdir: /nowhere\n");
		expect(worldTreesAmong([outside, repository], home)).toEqual([]);
	});

	it("never keeps a link beneath the trees folder, to outside or to another tree", () => {
		const other = worktree("s-other");
		const outside = join(base, "elsewhere");
		mkdirSync(outside);
		writeFileSync(join(outside, ".git"), "gitdir: /nowhere\n");
		mkdirSync(join(trees, "s-mine"));
		symlinkSync(outside, join(trees, "s-mine/out"));
		symlinkSync(other, join(trees, "s-mine/src"));
		expect(
			worldTreesAmong(
				[join(trees, "s-mine/out"), join(home, "world/trees/s-mine/src")],
				home,
			),
		).toEqual([]);
	});

	it("never keeps a folder holding no .git file, or a git folder in its place", () => {
		mkdirSync(join(trees, "s-plain/src"), { recursive: true });
		mkdirSync(join(trees, "s-clone/src/.git"), { recursive: true });
		expect(
			worldTreesAmong(
				[join(trees, "s-plain/src"), join(trees, "s-clone/src")],
				home,
			),
		).toEqual([]);
	});

	it("keeps none where the trees folder holds the home", () => {
		const roomy = join(base, "roomy");
		mkdirSync(join(roomy, "world"), { recursive: true });
		symlinkSync(base, join(roomy, "world/trees"));
		const tree = join(base, "roomy/src");
		mkdirSync(tree, { recursive: true });
		writeFileSync(join(tree, ".git"), "gitdir: /nowhere\n");
		expect(worldTreesAmong([tree], roomy)).toEqual([]);
	});
});

describe("the World trees a session writes", () => {
	it("counts those the broker's records hold for it, and no other session's", () => {
		const records = join(base, "records");
		const mine = worktree("s-mine");
		const theirs = worktree("s-theirs");
		const memory = createTreeMemory(records);
		memory.remember({
			identity: { key: "mine", shareable: false },
			path: join(home, "world/trees/s-mine/src"),
			providerId: "git-worktree",
			sessions: ["the-session"],
		});
		memory.remember({
			identity: { key: "theirs", shareable: false },
			path: theirs,
			providerId: "git-worktree",
			sessions: ["another-session"],
		});
		expect(sessionWorldTrees("the-session", home, records)).toEqual([
			{ tree: mine, repository },
		]);
		expect(sessionWorldTrees(undefined, home, records)).toEqual([]);
	});

	it("counts none the records name for several sessions, as a shared snapshot, since one writing it changes what the others read", () => {
		const records = join(base, "records");
		const shared = worktree("s-shared");
		createTreeMemory(records).remember({
			identity: { key: "shared", shareable: true },
			path: shared,
			providerId: "git-worktree",
			sessions: ["the-session", "another-session"],
		});
		expect(sessionWorldTrees("the-session", home, records)).toEqual([]);
		expect(sessionWorldTrees("another-session", home, records)).toEqual([]);
	});

	it("counts none where the records can't be read", () => {
		worktree("s-mine");
		expect(
			sessionWorldTrees("the-session", home, join(base, "no-records")),
		).toEqual([]);
	});
});

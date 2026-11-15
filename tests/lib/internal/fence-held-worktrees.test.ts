/**
 * The worktrees a fenced session holds but doesn't stand in. An agent
 * cuts a tree with the work tool and works in it from a command started
 * in its session's folder, and on 15 November, inside the fence, git
 * there could write no index or FETCH_HEAD, a World tree couldn't be
 * written at all, and pi's write tool refused them all. Each held tree
 * is now written as the working one is: its files and its own folder in
 * its repository's `worktrees`, with what points it elsewhere read-only.
 */

import { describe, expect, it } from "vitest";
import { fenceArgs, fenceRefusesWrite } from "../../../lib/internal/fence.ts";
import type { Disk } from "../../../lib/internal/fence-disk.ts";
import type { HeldWorktree } from "../../../lib/internal/fence-worktrees.ts";

/** A disk holding `paths`, a trailing slash marking a folder, and every folder above them. */
function diskOf(paths: readonly string[]): Disk {
	const kinds = new Map<string, "folder" | "file">();
	for (const given of paths) {
		const folder = given.endsWith("/");
		const path = folder ? given.slice(0, -1) : given;
		kinds.set(path, folder ? "folder" : "file");
		for (let up = path; up.lastIndexOf("/") > 0; ) {
			up = up.slice(0, up.lastIndexOf("/"));
			kinds.set(up, "folder");
		}
	}
	return {
		kind: (path) => kinds.get(path),
		entries: (folder) =>
			[...kinds.keys()]
				.filter((path) => path.slice(0, path.lastIndexOf("/")) === folder)
				.map((path) => path.slice(folder.length + 1)),
	};
}

const home = "/home/someone";
const start = `${home}/src/core`;
const brokers = `${home}/.local/state/pi/agentic-harness.pi/work/trees`;
const harness: HeldWorktree = {
	tree: `${brokers}/worktree-harness`,
	gitFolder: `${home}/src/harness/.git/worktrees/worktree-harness`,
};
const world: HeldWorktree = {
	tree: `${home}/world/trees/w-zone/src`,
	gitFolder: `${home}/world/git/worktrees/src221`,
};
const disk = diskOf([
	`${start}/.git/HEAD`,
	`${start}/.git/objects/`,
	`${home}/src/harness/.git/HEAD`,
	`${home}/src/harness/.git/objects/`,
	`${harness.gitFolder}/HEAD`,
	`${harness.gitFolder}/index`,
	`${harness.gitFolder}/commondir`,
	`${harness.gitFolder}/gitdir`,
	`${harness.tree}/.git`,
	`${home}/world/git/HEAD`,
	`${home}/world/git/objects/`,
	`${world.gitFolder}/HEAD`,
	`${world.gitFolder}/commondir`,
	`${world.gitFolder}/gitdir`,
	`${world.tree}/.git`,
]);
const place = {
	home,
	runtimeDir: "/run/user/1000",
	cwd: start,
	heldWorktrees: [harness, world],
	trees: {
		root: brokers,
		records: `${home}/.local/state/pi/agentic-harness.pi/work/cut`,
		held: [harness.tree, world.tree],
	},
};
const args = fenceArgs(place, disk);
/** Where `flag` binds `path` in the arguments, the last one counting, or -1. */
const at = (flag: string, path: string) =>
	args.reduce(
		(last, arg, index) =>
			arg === flag && args[index + 1] === path ? index : last,
		-1,
	);

describe("a worktree the session holds but doesn't stand in", () => {
	it("has its own git folder bound back writable over the read-only worktrees, for its index and FETCH_HEAD", () => {
		for (const { gitFolder } of [harness, world]) {
			expect(
				at("--bind", gitFolder),
				`${gitFolder} isn't bound back after the repository homes`,
			).toBeGreaterThan(at("--ro-bind", `${home}/src`));
		}
	});

	it("keeps what points it elsewhere read-only: its .git file, commondir and gitdir", () => {
		for (const { tree, gitFolder } of [harness, world]) {
			for (const path of [
				`${tree}/.git`,
				`${gitFolder}/commondir`,
				`${gitFolder}/gitdir`,
			]) {
				expect(
					at("--ro-bind", path),
					`${path} is writable over its folder`,
				).toBeGreaterThan(at("--bind", gitFolder));
			}
		}
	});

	it("is writable under ~/world, for commands and pi's file tools alike, but its .git file", () => {
		expect(
			at("--bind", world.tree),
			"the World tree isn't bound back over world's read-only bind",
		).toBeGreaterThan(at("--ro-bind", `${home}/world`));
		const refuses = (path: string) => fenceRefusesWrite(path, place, disk);
		expect(
			{
				file: refuses(`${world.tree}/areas/x.rb`),
				gitFile: refuses(`${world.tree}/.git`),
				otherTree: refuses(`${home}/world/trees/w-other/src/x.rb`),
				checkout: refuses(`${home}/src/harness/file.ts`),
			},
			"what pi's write tool may write",
		).toEqual({ file: false, gitFile: true, otherTree: true, checkout: true });
	});

	it("stays read-only when the session doesn't hold it", () => {
		const unheld = fenceArgs({ ...place, heldWorktrees: [] }, disk);
		const bound = unheld.some(
			(arg, index) => arg === "--bind" && unheld[index + 1] === world.tree,
		);
		expect(bound, "an unheld World tree was bound writable").toBe(false);
	});
});

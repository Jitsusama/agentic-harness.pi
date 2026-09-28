/**
 * A new worktree's first cargo build, started from a sibling's.
 *
 * A fresh worktree of a Rust repository starts with no target/, so its first
 * build compiles every registry crate again and writes another full copy of
 * them to disk. On a copy-on-write filesystem a sibling's target/ can be
 * cloned in seconds for no space, and cargo reuses every registry crate in it,
 * since their fingerprints do not name the worktree. The work tool offers that
 * clone when it cuts a tree.
 */

import { describe, expect, it } from "vitest";
import {
	type WarmStartSeams,
	warmStart,
} from "../../extensions/work-integration/warm-start.ts";

/** A filesystem of paths with modification times, and repositories by tree. */
function disk(
	files: Record<string, number>,
	repositories: Record<string, string>,
	cloneWorks = true,
) {
	const cloned: Array<{ from: string; to: string }> = [];
	const seams: WarmStartSeams = {
		modifiedAt: (path) => files[path],
		repositoryOf: async (tree) => repositories[tree],
		clone: async (from, to) => {
			cloned.push({ from, to });
			return cloneWorks;
		},
	};
	return { seams, cloned };
}

/** The files that make a tree a cargo tree with a debug build as of `at`. */
function built(tree: string, at: number): Record<string, number> {
	return {
		[`${tree}/Cargo.toml`]: 1,
		[`${tree}/target/.rustc_info.json`]: 1,
		[`${tree}/target/debug/deps`]: at,
	};
}

describe("warming a new tree's cargo target", () => {
	it("clones the target of the sibling that built most recently", async () => {
		const { seams, cloned } = disk(
			{
				"/trees/new/Cargo.toml": 1,
				...built("/trees/old", 100),
				...built("/trees/recent", 200),
			},
			{
				"/trees/new": "/repo/.git",
				"/trees/old": "/repo/.git",
				"/trees/recent": "/repo/.git",
			},
		);

		const from = await warmStart(
			"/trees/new",
			["/trees/old", "/trees/recent"],
			seams,
		);

		expect(from).toBe("/trees/recent");
		expect(cloned).toEqual([
			{ from: "/trees/recent/target", to: "/trees/new/target" },
		]);
	});

	it("passes over a sibling of another repository, however recent", async () => {
		const { seams } = disk(
			{
				"/trees/new/Cargo.toml": 1,
				...built("/trees/same", 100),
				...built("/trees/other", 900),
			},
			{
				"/trees/new": "/repo/.git",
				"/trees/same": "/repo/.git",
				"/trees/other": "/else/.git",
			},
		);

		expect(
			await warmStart("/trees/new", ["/trees/same", "/trees/other"], seams),
		).toBe("/trees/same");
	});

	it("passes over a target cargo did not write", async () => {
		const { seams } = disk(
			{
				"/trees/new/Cargo.toml": 1,
				"/trees/odd/target/debug/deps": 500,
			},
			{ "/trees/new": "/repo/.git", "/trees/odd": "/repo/.git" },
		);

		expect(
			await warmStart("/trees/new", ["/trees/odd"], seams),
		).toBeUndefined();
	});

	it("leaves a tree that is not a cargo workspace alone", async () => {
		const { seams, cloned } = disk(built("/trees/old", 100), {
			"/trees/new": "/repo/.git",
			"/trees/old": "/repo/.git",
		});

		expect(
			await warmStart("/trees/new", ["/trees/old"], seams),
		).toBeUndefined();
		expect(cloned).toEqual([]);
	});

	it("leaves a tree that already has a target alone", async () => {
		const { seams, cloned } = disk(
			{
				"/trees/new/Cargo.toml": 1,
				"/trees/new/target": 1,
				...built("/trees/old", 100),
			},
			{ "/trees/new": "/repo/.git", "/trees/old": "/repo/.git" },
		);

		expect(
			await warmStart("/trees/new", ["/trees/old"], seams),
		).toBeUndefined();
		expect(cloned).toEqual([]);
	});

	it("never counts the tree itself as its own source", async () => {
		const { seams } = disk(
			{ "/trees/new/Cargo.toml": 1 },
			{ "/trees/new": "/repo/.git" },
		);

		expect(
			await warmStart("/trees/new", ["/trees/new"], seams),
		).toBeUndefined();
	});

	it("reports nothing when the clone fails", async () => {
		const { seams } = disk(
			{ "/trees/new/Cargo.toml": 1, ...built("/trees/old", 100) },
			{ "/trees/new": "/repo/.git", "/trees/old": "/repo/.git" },
			false,
		);

		expect(
			await warmStart("/trees/new", ["/trees/old"], seams),
		).toBeUndefined();
	});
});

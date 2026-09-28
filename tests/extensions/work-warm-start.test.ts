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

import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CloneSeams,
	cloneTarget,
	holdBuildLock,
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

/** A Cargo.lock entry, sourced from the registry unless `path` is set. */
function lockEntry(name: string, path = false): string {
	const source = path
		? ""
		: 'source = "registry+https://github.com/rust-lang/crates.io-index"\n';
	return `[[package]]\nname = "${name}"\nversion = "1.0.0"\n${source}`;
}

/** Write files under `root`, making directories on the way. */
function lay(root: string, files: Record<string, string>): void {
	for (const [path, body] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), body);
	}
}

/**
 * Two trees of one workspace: `old` built its member `app`, the patched path
 * dependency `gix-hash` and the registry crate `tokio`, in debug and release;
 * `new` has only its source. The new tree also added a member, `extra`, that
 * the old one's lock has never heard of.
 */
function siblings() {
	const root = mkdtempSync(join(tmpdir(), "warm-start-"));
	const old = join(root, "old");
	const fresh = join(root, "new");
	lay(old, {
		"Cargo.lock": [
			lockEntry("app", true),
			lockEntry("gix-hash", true),
			lockEntry("tokio"),
		].join("\n"),
		"target/.rustc_info.json": "{}",
		"target/CACHEDIR.TAG": "Signature: 8a477f597d28d172789f06886806bc55",
		"target/debug/.cargo-lock": "",
		"target/debug/.fingerprint/app-1a/lib-app": "a",
		"target/debug/.fingerprint/app-2b/test-lib-app": "a",
		"target/debug/.fingerprint/gix-hash-3c/lib-gix_hash": "g",
		"target/debug/.fingerprint/extra-4d/lib-extra": "e",
		"target/debug/.fingerprint/tokio-5e/lib-tokio": "t",
		"target/debug/deps/libtokio-5e.rlib": "tokio",
		"target/debug/deps/libapp-1a.rlib": "app",
		"target/debug/build/tokio-6f/output": "",
		"target/debug/incremental/app-1a/s-x/dep-graph.bin": "graph",
		"target/debug/app": "binary",
		"target/debug/app.d": "deps",
		"target/release/.fingerprint/app-7a/bin-app": "a",
		"target/release/.fingerprint/tokio-8b/lib-tokio": "t",
		"target/release/deps/libtokio-8b.rlib": "tokio",
		"target/tmp/scratch": "not a profile",
	});
	lay(fresh, {
		"Cargo.lock": [
			lockEntry("app", true),
			lockEntry("extra", true),
			lockEntry("tokio"),
		].join("\n"),
	});
	return { root, from: join(old, "target"), to: join(fresh, "target"), fresh };
}

/** Seams that clone by copying, and a lock no build holds unless named. */
function machine(held: readonly string[] = []) {
	const released: string[] = [];
	const seams: CloneSeams = {
		cloneEntry: async (from, to) => {
			cpSync(from, to, { recursive: true, verbatimSymlinks: true });
			return true;
		},
		holdBuildLock: async (profile) =>
			held.includes(profile)
				? undefined
				: async () => {
						released.push(profile);
					},
	};
	return { seams, released };
}

/** Every file under `dir`, relative to it, sorted. */
function filesUnder(dir: string): string[] {
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1))
		.sort();
}

describe("cloning a sibling's cargo target", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	});
	function fixture() {
		const trees = siblings();
		roots.push(trees.root);
		return trees;
	}

	it("keeps what the registry built and drops what this repository did", async () => {
		// Cargo hashes a path package by its place in the workspace, so the
		// same member in two worktrees gets the same fingerprint, and a build
		// the sibling ran after this tree was cut would pass for fresh here.
		const { from, to } = fixture();

		expect(await cloneTarget(from, to, machine().seams)).toBe(true);

		expect(filesUnder(to)).toEqual([
			".rustc_info.json",
			"CACHEDIR.TAG",
			"debug/.fingerprint/tokio-5e/lib-tokio",
			"debug/build/tokio-6f/output",
			"debug/deps/libapp-1a.rlib",
			"debug/deps/libtokio-5e.rlib",
			"release/.fingerprint/tokio-8b/lib-tokio",
			"release/deps/libtokio-8b.rlib",
		]);
	});

	it("holds every profile's build lock while it clones, then lets go", async () => {
		const { from, to } = fixture();
		const { seams, released } = machine();

		await cloneTarget(from, to, seams);

		expect(released.sort()).toEqual([
			join(from, "debug"),
			join(from, "release"),
		]);
	});

	it("refuses while a build holds the sibling's lock", async () => {
		const { from, to, fresh } = fixture();
		const { seams, released } = machine([join(from, "release")]);

		expect(await cloneTarget(from, to, seams)).toBe(false);

		expect(readdirSync(fresh)).toEqual(["Cargo.lock"]);
		expect(released).toEqual([join(from, "debug")]);
	});

	it("leaves nothing behind when the filesystem cannot clone", async () => {
		const { from, to, fresh } = fixture();
		const { seams } = machine();
		seams.cloneEntry = async (entry, dest) =>
			entry.endsWith("deps") ? false : machine().seams.cloneEntry(entry, dest);

		expect(await cloneTarget(from, to, seams)).toBe(false);

		expect(readdirSync(fresh)).toEqual(["Cargo.lock"]);
	});

	it("refuses a target with no fingerprint of this repository", async () => {
		// Every build of the workspace fingerprints its members, so a target
		// without one is laid out some way this does not understand, and
		// keeping it would reuse whatever it holds unchecked.
		const { from, to, fresh } = fixture();
		for (const profile of ["debug", "release"]) {
			for (const fingerprint of readdirSync(
				join(from, profile, ".fingerprint"),
			)) {
				if (!fingerprint.startsWith("tokio-")) {
					rmSync(join(from, profile, ".fingerprint", fingerprint), {
						recursive: true,
					});
				}
			}
		}

		expect(await cloneTarget(from, to, machine().seams)).toBe(false);

		expect(readdirSync(fresh)).toEqual(["Cargo.lock"]);
	});

	it("refuses when neither tree has a Cargo.lock to name its packages", async () => {
		const { from, to, fresh } = fixture();
		rmSync(join(fresh, "Cargo.lock"));
		rmSync(join(dirname(from), "Cargo.lock"));

		expect(await cloneTarget(from, to, machine().seams)).toBe(false);

		expect(readdirSync(fresh)).toEqual([]);
	});

	it("takes cargo's lock only while nothing else holds it", async () => {
		const { from } = fixture();
		const profile = join(from, "debug");

		const first = await holdBuildLock(profile);
		const second = await holdBuildLock(profile);
		await first?.();
		const third = await holdBuildLock(profile);
		await third?.();

		expect([first, second, third].map((held) => held !== undefined)).toEqual([
			true,
			false,
			true,
		]);
	});

	it("leaves a target that a build made while it cloned alone", async () => {
		const { from, to, fresh } = fixture();
		const { seams } = machine();
		const clone = seams.cloneEntry;
		seams.cloneEntry = async (entry, dest) => {
			lay(to, { "debug/.cargo-lock": "" });
			return clone(entry, dest);
		};

		expect(await cloneTarget(from, to, seams)).toBe(false);

		expect(filesUnder(to)).toEqual(["debug/.cargo-lock"]);
		expect(readdirSync(fresh).sort()).toEqual(["Cargo.lock", "target"]);
		expect(existsSync(join(to, "debug", ".fingerprint"))).toBe(false);
	});
});

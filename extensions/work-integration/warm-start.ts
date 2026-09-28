/**
 * Start a new tree's cargo build from a sibling's.
 *
 * A fresh worktree of a Rust repository has no target/, so its first build
 * compiles every registry crate again and writes another full copy of them.
 * That is most of what fills a disk when several agents each cut a tree of the
 * same workspace. On a copy-on-write filesystem a sibling's target/ clones in
 * seconds and costs nothing until one side writes, and cargo reuses the
 * registry crates in it, because their fingerprints name the registry rather
 * than the worktree. The workspace's own crates are made to rebuild.
 */

import { spawn } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	rmSync,
	statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Exec } from "@jitsusama/agentic-harness.core/exec";

/** What warming a tree needs from the machine. */
export interface WarmStartSeams {
	/** When the path was last modified, or undefined when it is absent. */
	modifiedAt(path: string): number | undefined;
	/** The git common directory the tree belongs to. */
	repositoryOf(tree: string): Promise<string | undefined>;
	/** Clone a target directory without copying its blocks; false when it could not. */
	clone(from: string, to: string): Promise<boolean>;
}

/**
 * Clone the most recently built sibling's target/ into `tree`, and name the
 * sibling it came from, or undefined when nothing was cloned.
 *
 * Only a cargo tree with no target/ of its own is warmed, and only from a tree
 * of the same repository: another workspace's crates share names and nothing
 * else. A candidate counts only with the `.rustc_info.json` cargo writes at the
 * root of every target it uses, so a directory that merely happens to be
 * called target is never taken for a build. (Not CACHEDIR.TAG: cargo writes
 * that only when it creates target/ itself, and a justfile that makes
 * target/tmp first means it never does.) The newest
 * `target/debug/deps` wins, since that is the build nearest to what the new
 * tree's first one will ask for.
 */
export async function warmStart(
	tree: string,
	candidates: readonly string[],
	seams: WarmStartSeams,
): Promise<string | undefined> {
	if (seams.modifiedAt(`${tree}/Cargo.toml`) === undefined) return undefined;
	if (seams.modifiedAt(`${tree}/target`) !== undefined) return undefined;
	const repository = await seams.repositoryOf(tree);
	if (repository === undefined) return undefined;

	let newest: { tree: string; at: number } | undefined;
	for (const candidate of candidates) {
		if (candidate === tree) continue;
		if (
			seams.modifiedAt(`${candidate}/target/.rustc_info.json`) === undefined
		) {
			continue;
		}
		const at = seams.modifiedAt(`${candidate}/target/debug/deps`);
		if (at === undefined || (newest && at <= newest.at)) continue;
		if ((await seams.repositoryOf(candidate)) !== repository) continue;
		newest = { tree: candidate, at };
	}
	if (!newest) return undefined;
	const cloned = await seams.clone(`${newest.tree}/target`, `${tree}/target`);
	return cloned ? newest.tree : undefined;
}

/** What cloning one target into another needs from the machine. */
export interface CloneSeams {
	/**
	 * Clone one file or directory tree copy-on-write, or answer false. Never a
	 * real copy: a full copy of a target is the very disk this exists to save.
	 */
	cloneEntry(from: string, to: string): Promise<boolean>;
	/**
	 * Take cargo's build lock on a profile without waiting, and answer how to
	 * let it go, or undefined while a build holds it.
	 */
	holdBuildLock(profile: string): Promise<(() => Promise<void>) | undefined>;
}

/**
 * What a profile's clone leaves out: incremental state, which belongs to the
 * workspace's own crates and would never be read again, and the lock file.
 * Files at the top of a profile are the binaries cargo uplifts, which stay the
 * sibling's until the first build here links its own, so they are left out too.
 */
const SKIPPED = new Set(["incremental", ".cargo-lock"]);

/**
 * Clone target `from` into the absent target `to`, and answer whether it did.
 *
 * Every profile (a directory with a `.fingerprint`) is cloned whole under
 * cargo's lock, so no build in the sibling writes into it halfway. Then the
 * fingerprint of every package this repository builds from its own paths is
 * removed, so those rebuild: cargo hashes a path package by its place in the
 * workspace, so the same member gets the same hash in every worktree, and a
 * build the sibling ran after this tree was checked out would otherwise pass
 * for fresh here. The result is assembled beside `to` and moved into place
 * only if nothing made `to` meanwhile. Anything short of that leaves no trace.
 */
export async function cloneTarget(
	from: string,
	to: string,
	seams: CloneSeams,
): Promise<boolean> {
	const ours = new Set([
		...pathPackagesOf(dirname(from)),
		...pathPackagesOf(dirname(to)),
	]);
	if (ours.size === 0) return false;
	const profiles = readdirSync(from, { withFileTypes: true })
		.filter(
			(entry) =>
				entry.isDirectory() &&
				statSync(join(from, entry.name, ".fingerprint"), {
					throwIfNoEntry: false,
				})?.isDirectory(),
		)
		.map((entry) => entry.name)
		.sort();
	if (profiles.length === 0) return false;

	let staging: string | undefined;
	try {
		const releases: Array<() => Promise<void>> = [];
		try {
			for (const profile of profiles) {
				const release = await seams.holdBuildLock(join(from, profile));
				if (!release) return false;
				releases.push(release);
			}
			staging = mkdtempSync(join(dirname(to), ".target-warming-"));
			if (!(await cloneProfiles(from, staging, profiles, seams))) return false;
		} finally {
			await Promise.all(releases.map((release) => release()));
		}
		if (dropOwnFingerprints(staging, profiles, ours) === 0) return false;
		return landInPlace(staging, to);
	} finally {
		if (staging) rmSync(staging, { recursive: true, force: true });
	}
}

/** Clone the target's own files and each profile's directories into `staging`. */
async function cloneProfiles(
	from: string,
	staging: string,
	profiles: readonly string[],
	seams: CloneSeams,
): Promise<boolean> {
	const pairs: Array<[string, string]> = [];
	for (const entry of readdirSync(from, { withFileTypes: true })) {
		if (entry.isFile()) {
			pairs.push([join(from, entry.name), join(staging, entry.name)]);
		}
	}
	for (const profile of profiles) {
		mkdirSync(join(staging, profile));
		for (const entry of readdirSync(join(from, profile), {
			withFileTypes: true,
		})) {
			if (entry.isDirectory() && !SKIPPED.has(entry.name)) {
				pairs.push([
					join(from, profile, entry.name),
					join(staging, profile, entry.name),
				]);
			}
		}
	}
	for (const [source, destination] of pairs) {
		if (!(await seams.cloneEntry(source, destination))) return false;
	}
	return true;
}

/** Remove each profile's fingerprints of `ours`, and count them. */
function dropOwnFingerprints(
	staging: string,
	profiles: readonly string[],
	ours: ReadonlySet<string>,
): number {
	let removed = 0;
	for (const profile of profiles) {
		const fingerprints = join(staging, profile, ".fingerprint");
		for (const fingerprint of readdirSync(fingerprints)) {
			// Named `<package>-<hash>`, and a package name may hold dashes.
			const cut = fingerprint.lastIndexOf("-");
			if (cut > 0 && ours.has(fingerprint.slice(0, cut))) {
				rmSync(join(fingerprints, fingerprint), { recursive: true });
				removed++;
			}
		}
	}
	// Every build of a workspace fingerprints its members, so none at all
	// means a layout this does not understand, and reuse would go unchecked.
	return removed;
}

/**
 * Move `staging` to `to` only where nothing appeared meanwhile. mkdir fails on
 * an existing path; the rename replaces only the empty directory just made,
 * and fails once a cargo that started in the gap has written into it.
 */
function landInPlace(staging: string, to: string): boolean {
	try {
		mkdirSync(to);
	} catch {
		return false;
	}
	try {
		renameSync(staging, to);
		return true;
	} catch {
		try {
			rmdirSync(to);
		} catch {
			// Not empty: a build owns it now.
		}
		return false;
	}
}

/** The packages a tree's Cargo.lock names without a source, if it has one. */
function pathPackagesOf(tree: string): Set<string> {
	let lock: string;
	try {
		lock = readFileSync(join(tree, "Cargo.lock"), "utf8");
	} catch {
		return new Set();
	}
	return lockedPathPackages(lock);
}

/**
 * Every package a Cargo.lock records without a `source`: the workspace's
 * members, path dependencies outside it, and `[patch]` paths. Registry and git
 * packages always carry one.
 */
export function lockedPathPackages(lock: string): Set<string> {
	const names = new Set<string>();
	let name: string | undefined;
	let sourced = false;
	for (const raw of [...lock.split("\n"), "[end]"]) {
		const line = raw.trim();
		if (line.startsWith("[")) {
			if (name !== undefined && !sourced) names.add(name);
			name = undefined;
			sourced = false;
		} else if (line.startsWith("name = ")) {
			name = JSON.parse(line.slice("name = ".length));
		} else if (line.startsWith("source = ")) {
			sourced = true;
		}
	}
	return names;
}

/**
 * The trees a new one could warm from: everything beside it, which is where
 * the broker cuts every tree, and the checkout it was cut from.
 */
export function candidatesFor(
	tree: string,
	checkout: string | undefined,
): string[] {
	const parent = dirname(tree);
	let siblings: string[] = [];
	try {
		siblings = readdirSync(parent, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => join(parent, entry.name));
	} catch {
		// No readable parent means no siblings, not a failed cut.
	}
	return checkout ? [checkout, ...siblings] : siblings;
}

/** The seams as this machine answers them. */
export function machineSeams(exec: Exec): WarmStartSeams {
	const cloneSeams: CloneSeams = {
		cloneEntry: (from, to) => cloneEntry(exec, from, to),
		holdBuildLock,
	};
	return {
		modifiedAt: (path) => statSync(path, { throwIfNoEntry: false })?.mtimeMs,
		repositoryOf: async (tree) => {
			const result = await exec("git", [
				"-C",
				tree,
				"rev-parse",
				"--path-format=absolute",
				"--git-common-dir",
			]);
			return result.code === 0 ? result.stdout.trim() : undefined;
		},
		clone: (from, to) => cloneTarget(from, to, cloneSeams),
	};
}

/**
 * clonefile(2), through JavaScript for Automation, since every Mac has it and
 * Node cannot force a clone there (libuv answers COPYFILE_FICLONE_FORCE with
 * ENOSYS). Not `cp -c`, which quietly falls back to a full copy across volumes
 * or onto a filesystem without clones. clonefile clones a whole hierarchy in
 * one call, keeps modification times, and fails instead.
 */
const CLONEFILE = `function run(argv) {
	ObjC.bindFunction("clonefile", ["int", ["char *", "char *", "unsigned int"]]);
	return String($.clonefile(argv[0], argv[1], 1));
}`;

/** Clone one entry copy-on-write, or answer false. */
async function cloneEntry(
	exec: Exec,
	from: string,
	to: string,
): Promise<boolean> {
	if (process.platform === "darwin") {
		const result = await exec("osascript", [
			"-l",
			"JavaScript",
			"-e",
			CLONEFILE,
			from,
			to,
		]);
		return result.code === 0 && result.stdout.trim() === "0";
	}
	if (process.platform === "linux") {
		// --reflink=always fails where the filesystem cannot share extents.
		const result = await exec("cp", [
			"--reflink=always",
			"-R",
			"-p",
			"--no-dereference",
			from,
			to,
		]);
		return result.code === 0;
	}
	return false;
}

/**
 * Hold flock(2) on the profile's `.cargo-lock`, the lock cargo holds for the
 * whole of a build, until released. Perl, since Node has no flock and every
 * Mac and nearly every Linux has perl; without it nothing is warmed.
 */
const HOLD_LOCK =
	'open(my $f, ">>", $ARGV[0]) or exit 2; flock($f, LOCK_EX | LOCK_NB) or exit 1; $| = 1; print "held\\n"; <STDIN>;';

export function holdBuildLock(
	profile: string,
): Promise<(() => Promise<void>) | undefined> {
	return new Promise((resolve) => {
		const child = spawn(
			"perl",
			["-MFcntl=:flock", "-e", HOLD_LOCK, join(profile, ".cargo-lock")],
			{ stdio: ["pipe", "pipe", "ignore"] },
		);
		const exited = new Promise<void>((done) => child.once("close", done));
		let settled = false;
		const settle = (answer: (() => Promise<void>) | undefined) => {
			if (!settled) {
				settled = true;
				resolve(answer);
			}
		};
		child.once("error", () => settle(undefined));
		exited.then(() => settle(undefined));
		child.stdout.once("data", () =>
			settle(async () => {
				child.stdin.end();
				await exited;
			}),
		);
	});
}

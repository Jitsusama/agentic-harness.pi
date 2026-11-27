/**
 * Trees cut from a seed rather than filled file by file.
 *
 * A full cut writes every file of the repository: on optimus at 15:13 on
 * 27 November a harness cut of 2,199 files read 138 MB, wrote 102 MB and
 * took 92 s waiting on the disk, and about 54 were cut an hour, most of
 * them snapshots of a new head for a round. On btrfs a subvolume's
 * snapshot is copy-on-write and writes no files, so each checkout keeps
 * one clean tree, its seed, that no session holds or sees. A cut is then
 * a snapshot of the seed, given its own entry in the checkout and moved
 * to the commit asked for by a read-tree that writes only the files that
 * differ: 3.8 s against 41.9 s for a full cut, measured there at 15:27
 * under the same load.
 *
 * A seed is never changed once made, so a snapshot never catches one
 * half written, and no tree a session holds is touched: a new seed is a
 * snapshot of a tree just cut, taken before anyone has it, at a path of
 * its own, which a pointer beside it names once it is whole. Anything
 * here that fails leaves the cut to be filled in full, as every cut was
 * before.
 */

import { createHash, randomBytes } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { removeTreeOff } from "../../../internal/files/remove-tree.ts";
import type { Exec } from "../../exec/index.ts";

/**
 * How long a seed serves before the next cut makes a newer one. Each
 * cut writes the files that differ from its seed, which grow as trunk
 * moves: 87 for twenty harness merges, against thousands for a full cut.
 */
export const SEED_FRESH_MS = 6 * 60 * 60 * 1000;

/** Copies the subvolume at `from` to `to`, which must not exist yet. */
export type Snapshot = (
	exec: Exec,
	from: string,
	to: string,
) => Promise<boolean>;

/** btrfs's own snapshot, which needs no root for a subvolume one owns. */
export const btrfsSnapshot: Snapshot = async (exec, from, to) =>
	(await exec("btrfs", ["subvolume", "snapshot", from, to])).code === 0;

/** A checkout's seeds, kept for cutting its trees. */
export interface Seeds {
	/** The seed to cut a tree of `checkout` from, or none yet. */
	current(checkout: string): string | undefined;
	/**
	 * Fill the tree whose entry git just made at `path`, with no files
	 * checked out, from `seed`; or, where that fails, in full.
	 */
	fill(exec: Exec, seed: string, path: string): Promise<void>;
	/**
	 * Keep the tree just cut at `path` as the seed of `checkout` where it
	 * has none or one past {@link SEED_FRESH_MS}, before anyone has the
	 * tree. A seed that can't be made leaves the next cut full, so this
	 * costs only speed when it fails, and throws nothing.
	 */
	keep(exec: Exec, checkout: string, path: string): Promise<void>;
}

/** The seeds kept under `dir`, which must share the trees' filesystem. */
export function seedsAt(
	dir: string,
	snapshot: Snapshot = btrfsSnapshot,
	now: () => number = Date.now,
): Seeds {
	const pointer = (checkout: string) => join(dir, `${nameOf(checkout)}.seed`);
	const current = (checkout: string): string | undefined => {
		try {
			const seed = readFileSync(pointer(checkout), "utf8").trim();
			return seed === "" ? undefined : seed;
		} catch {
			// No pointer is a checkout with no seed yet, which cuts in full.
			return undefined;
		}
	};
	const point = (checkout: string, seed: string) => {
		const at = pointer(checkout);
		const next = `${at}.${randomBytes(4).toString("hex")}`;
		writeFileSync(next, `${seed}\n`);
		renameSync(next, at);
	};

	return {
		current,

		async fill(exec, seed, path) {
			// Read first, since a seeding stopped halfway may leave no `.git`.
			const mine = readFileSync(join(path, ".git"), "utf8");
			let seeded = false;
			try {
				seeded = await fromSeed(exec, snapshot, seed, path);
			} catch {
				// Whatever stopped it, the tree is filled in full below.
			}
			if (!seeded) await inFull(exec, path, mine);
		},

		async keep(exec, checkout, path) {
			const at = pointer(checkout);
			const was = current(checkout);
			if (was !== undefined && !olderThan(at, SEED_FRESH_MS, now())) return;
			try {
				const head = await exec("git", ["-C", path, "rev-parse", "HEAD"]);
				if (head.code !== 0) return;
				const commit = head.stdout.trim();
				const seed = join(dir, `${nameOf(checkout)}-${commit.slice(0, 12)}`);
				if (existsSync(join(seed, ".git"))) {
					// A seed at this commit stands already, so it serves again.
					point(checkout, seed);
					return;
				}
				mkdirSync(dir, { recursive: true });
				const entry = await exec("git", [
					"-C",
					checkout,
					"worktree",
					"add",
					"--no-checkout",
					"--detach",
					seed,
					commit,
				]);
				if (entry.code !== 0) return;
				if (!(await fromCopy(exec, snapshot, path, seed))) {
					await exec("git", [
						"-C",
						checkout,
						"worktree",
						"remove",
						"--force",
						seed,
					]);
					return;
				}
				point(checkout, seed);
				await retire(exec, dir, nameOf(checkout), [seed, was]);
			} catch {
				// A seed not made leaves the next cut full, which is how every
				// cut was made before seeds; the cut itself stands either way.
			}
		},
	};
}

/**
 * Fill `path` from a snapshot of `seed`, saying whether it could. The
 * seed's index comes with its files, so a refresh finds them as the seed
 * left them and the read-tree writes only the files that differ from
 * the commit `path`'s entry stands at.
 */
async function fromSeed(
	exec: Exec,
	snapshot: Snapshot,
	seed: string,
	path: string,
): Promise<boolean> {
	const was = await exec("git", ["-C", seed, "rev-parse", "HEAD"]);
	if (was.code !== 0) return false;
	if (!(await fromCopy(exec, snapshot, seed, path))) return false;
	const git = (...args: string[]) => exec("git", ["-C", path, ...args]);
	if ((await git("update-index", "-q", "--refresh")).code !== 0) return false;
	return (
		(await git("read-tree", "-m", "-u", was.stdout.trim(), "HEAD")).code === 0
	);
}

/**
 * Put a snapshot of the tree at `from` at `to`, where git has just made
 * an entry and nothing else, keeping `to`'s own `.git` and giving its
 * entry `from`'s index; whether it could. Where the snapshot couldn't be
 * taken, `to` is left as git made it.
 */
async function fromCopy(
	exec: Exec,
	snapshot: Snapshot,
	from: string,
	to: string,
): Promise<boolean> {
	const mine = readFileSync(join(to, ".git"), "utf8");
	const index = readFileSync(join(entryOf(from), "index"));
	rmSync(join(to, ".git"));
	// Only an empty folder goes, so a `to` holding anything else stops here.
	rmdirSync(to);
	if (!(await snapshot(exec, from, to))) {
		mkdirSync(to, { recursive: true });
		writeFileSync(join(to, ".git"), mine);
		return false;
	}
	writeFileSync(join(to, ".git"), mine);
	writeFileSync(join(entryOf(to), "index"), index);
	return true;
}

/**
 * Fill `path` in full from the commit its entry stands at, whatever a
 * failed seeding left there: everything goes first, and its `.git`,
 * `mine`, comes back.
 */
async function inFull(exec: Exec, path: string, mine: string): Promise<void> {
	mkdirSync(path, { recursive: true });
	for (const name of readdirSync(path)) {
		await removeTreeOff(join(path, name));
	}
	writeFileSync(join(path, ".git"), mine);
	rmSync(join(entryOf(path), "index"), { force: true });
	const filled = await exec("git", [
		"-C",
		path,
		"read-tree",
		"--reset",
		"-u",
		"HEAD",
	]);
	if (filled.code !== 0) {
		throw new Error(
			`git couldn't fill the tree at ${path}: ${filled.stderr.trim() || filled.stdout.trim()}`,
		);
	}
}

/** The folder of git's entry for the tree at `tree`, as its `.git` names it. */
function entryOf(tree: string): string {
	const said = readFileSync(join(tree, ".git"), "utf8").trim();
	if (!said.startsWith("gitdir: ")) {
		throw new Error(`${join(tree, ".git")} names no git folder`);
	}
	return said.slice("gitdir: ".length);
}

/**
 * Take out the seeds of `name` but those `kept`, through git. The one
 * the pointer named until now is kept with the new one, since a cut may
 * be snapshotting it; any older was replaced at least
 * {@link SEED_FRESH_MS} ago, far longer than a cut takes.
 */
async function retire(
	exec: Exec,
	dir: string,
	name: string,
	kept: readonly (string | undefined)[],
): Promise<void> {
	for (const entry of readdirSync(dir)) {
		const seed = join(dir, entry);
		if (!entry.startsWith(`${name}-`) || kept.includes(seed)) continue;
		await exec("git", ["-C", seed, "worktree", "remove", "--force", seed]);
	}
}

/** Whether the file at `path` last changed more than `ms` before `at`. */
function olderThan(path: string, ms: number, at: number): boolean {
	try {
		return at - statSync(path).mtimeMs > ms;
	} catch {
		// Gone already, which nothing need wait for.
		return true;
	}
}

/**
 * A checkout's seed name: its folder's name, for a reader, and a hash
 * of its whole path, so two checkouts of one name keep their own.
 */
function nameOf(checkout: string): string {
	const hash = createHash("sha256").update(checkout).digest("hex").slice(0, 8);
	return `${basename(checkout)}-${hash}`;
}

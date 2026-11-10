/**
 * The Nix roots a tree's dev shell leaves behind, and dropping them
 * once nobody has entered the tree for a while.
 *
 * Entering a tree with direnv and nix-direnv builds its flake's dev
 * shell and roots it, with every flake input, under `.direnv`; a
 * `nix build` there leaves a `result` link that roots its output too.
 * Each root keeps its store paths from the garbage collector for as
 * long as the tree stands, and a worktree can stand for weeks after its
 * last entry: on 10 November 1,364 of the machine's roots sat in pi's
 * work trees, one tree alone holding 36. What they keep is a cache.
 * direnv builds the shell again on the next entry, mostly from the
 * binary cache, and a build is run again by whoever wants its output.
 *
 * nix-direnv touches every root it keeps on each entry, so the newest
 * root's time is when the tree was last used. Once that is past
 * {@link DEV_SHELL_IDLE_MS} the roots go together, as nix-direnv's own
 * cleanup takes them before it builds a new shell, with the profiles'
 * `.rc` files: left behind, one would load a shell whose paths may
 * since have been collected, where without it the next entry builds.
 */

import {
	lstatSync,
	readdirSync,
	readlinkSync,
	rmdirSync,
	rmSync,
} from "node:fs";
import { join } from "node:path";
import { count } from "../../ui/count.ts";

/**
 * How long a tree goes unentered before its dev shell's roots go.
 *
 * Three days: on 10 November 32 of the 75 trees holding roots had been
 * entered in the last three and none of the rest in the four before,
 * so a tree in use keeps its shell over a weekend, and one set down
 * gives its roots up within the week.
 */
export const DEV_SHELL_IDLE_MS = 3 * 24 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Where nix-direnv keeps its layout, beside the `.envrc`. */
const LAYOUT = ".direnv";

/** The layout's folder of flake input roots, one link an input. */
const FLAKE_INPUTS = "flake-inputs";

/** nix-direnv's profile links, `flake-profile-<hash>` and `nix-profile-<hash>`. */
const PROFILE = /^(?:flake|nix)-profile-/;

/** The links `nix build` leaves, `result` and `result-<output>`. */
const RESULT = /^result(?:-.+)?$/;

/** The roots a tree holds, and when the newest was touched. */
export interface DevShellRoots {
	/** Each root, as an absolute path inside the tree. */
	roots: string[];
	/** Milliseconds since the epoch, absent when there is no root. */
	lastTouched?: number;
}

/**
 * The Nix roots in a tree: nix-direnv's flake inputs and profiles in
 * `.direnv`, and the `result` links at its top that name a store path.
 * A `result` link naming anything else is somebody's own file.
 */
export function devShellRoots(tree: string): DevShellRoots {
	const layout = join(tree, LAYOUT);
	const roots = [
		...linksIn(join(layout, FLAKE_INPUTS), () => true),
		...linksIn(layout, (name) => PROFILE.test(name)),
		...linksIn(tree, (name) => RESULT.test(name)).filter(namesStorePath),
	];
	let lastTouched: number | undefined;
	for (const root of roots) {
		const touched = lstatSync(root, { throwIfNoEntry: false })?.mtimeMs;
		if (touched !== undefined && (lastTouched ?? 0) < touched) {
			lastTouched = touched;
		}
	}
	return lastTouched === undefined ? { roots } : { roots, lastTouched };
}

/**
 * Drop a tree's roots when none has been touched within
 * {@link DEV_SHELL_IDLE_MS} of `now`, answering how many went. All or
 * none: a tree entered since keeps every one, since its shell is one.
 */
export function dropIdleDevShellRoots(tree: string, now: number): number {
	const { roots, lastTouched } = devShellRoots(tree);
	if (lastTouched === undefined || now - lastTouched < DEV_SHELL_IDLE_MS) {
		return 0;
	}
	let dropped = 0;
	for (const root of roots) {
		try {
			rmSync(root);
			dropped += 1;
		} catch {
			// Gone since it was listed, or not ours to remove: either way
			// the next sweep looks again and nothing here depends on it.
		}
	}
	const layout = join(tree, LAYOUT);
	for (const rc of filesIn(layout, (name) => PROFILE.test(name))) {
		rmSync(rc, { force: true });
	}
	try {
		rmdirSync(join(layout, FLAKE_INPUTS));
	} catch {
		// Not empty, as when something new was put there, or never made.
	}
	return dropped;
}

/** A tree and the roots it holds, for {@link rootsReport}. */
export interface TreeRoots {
	path: string;
	roots: number;
	lastTouched?: number;
}

/**
 * Lines saying which trees hold Nix roots, most first, and which lose
 * them at the next sweep; none when no tree holds one.
 */
export function rootsReport(
	trees: readonly TreeRoots[],
	now: number,
): string[] {
	const holding = trees
		.filter((tree) => tree.roots > 0)
		.sort((a, b) => b.roots - a.roots);
	if (holding.length === 0) return [];
	const idle = (tree: TreeRoots): boolean =>
		tree.lastTouched !== undefined &&
		now - tree.lastTouched >= DEV_SHELL_IDLE_MS;
	const total = holding.reduce((sum, tree) => sum + tree.roots, 0);
	const going = holding.filter(idle).length;
	const days = DEV_SHELL_IDLE_MS / DAY_MS;
	return [
		`${count(holding.length, "tree")} here hold ${count(total, "Nix root")}${going > 0 ? `; ${going} not entered in ${days} days loses them at the next sweep` : ""}.`,
		...holding.map((tree) => {
			const entered =
				tree.lastTouched === undefined
					? ""
					: `, entered ${count(Math.floor((now - tree.lastTouched) / DAY_MS), "day")} ago`;
			return `   ${tree.path}: ${count(tree.roots, "root")}${entered}${idle(tree) ? ", dropped at the next sweep" : ""}`;
		}),
	];
}

/** The symbolic links directly in `dir` whose names `wanted` takes. */
function linksIn(dir: string, wanted: (name: string) => boolean): string[] {
	return entriesIn(dir)
		.filter((entry) => entry.isSymbolicLink() && wanted(entry.name))
		.map((entry) => join(dir, entry.name));
}

/** The plain files directly in `dir` whose names `wanted` takes. */
function filesIn(dir: string, wanted: (name: string) => boolean): string[] {
	return entriesIn(dir)
		.filter((entry) => entry.isFile() && wanted(entry.name))
		.map((entry) => join(dir, entry.name));
}

function entriesIn(dir: string) {
	try {
		return readdirSync(dir, { withFileTypes: true });
	} catch {
		// No such folder: a tree nobody entered has no layout at all.
		return [];
	}
}

/** Whether a link names a path in the Nix store. */
function namesStorePath(link: string): boolean {
	const store = `${process.env.NIX_STORE_DIR ?? "/nix/store"}/`;
	try {
		return readlinkSync(link).startsWith(store);
	} catch {
		// Gone since it was listed, so it roots nothing.
		return false;
	}
}

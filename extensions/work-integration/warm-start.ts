/**
 * Start a new tree's cargo build from a sibling's.
 *
 * A fresh worktree of a Rust repository has no target/, so its first build
 * compiles every registry crate again and writes another full copy of them.
 * That is most of what fills a disk when several agents each cut a tree of the
 * same workspace. On a copy-on-write filesystem a sibling's target/ clones in
 * seconds and costs nothing until one side writes, and cargo reuses the
 * registry crates in it, because their fingerprints name the registry rather
 * than the worktree. The workspace's own crates rebuild, as they would anyway.
 */

import { readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Exec } from "@jitsusama/agentic-harness.core/exec";

/** What warming a tree needs from the machine. */
export interface WarmStartSeams {
	/** When the path was last modified, or undefined when it is absent. */
	modifiedAt(path: string): number | undefined;
	/** The git common directory the tree belongs to. */
	repositoryOf(tree: string): Promise<string | undefined>;
	/** Clone a directory without copying its blocks; false when it could not. */
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
		clone: async (from, to) => {
			// Clones only. A plain copy of a 50 GiB target is the very cost
			// this exists to avoid, so a filesystem that cannot clone gets
			// nothing rather than a slow full copy.
			const args =
				process.platform === "darwin"
					? ["-cR", from, to]
					: process.platform === "linux"
						? ["-R", "--reflink=always", from, to]
						: undefined;
			if (!args) return false;
			const result = await exec("cp", args);
			if (result.code !== 0) {
				rmSync(to, { recursive: true, force: true });
				return false;
			}
			dropIncremental(to);
			return true;
		},
	};
}

/**
 * Drop each profile's incremental state from a cloned target.
 *
 * It belongs to the workspace's own crates, which rebuild in the new tree
 * under new names, so it would never be read again. Cloned, it costs nothing
 * today, but it holds its blocks once the sibling it came from moves on.
 */
function dropIncremental(target: string): void {
	for (const profile of readdirSync(target, { withFileTypes: true })) {
		if (profile.isDirectory()) {
			rmSync(join(target, profile.name, "incremental"), {
				recursive: true,
				force: true,
			});
		}
	}
}

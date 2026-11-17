/**
 * The work broker's trees inside the fence. pi's work tool runs git
 * outside the fence in every tree the broker cut, so a command that
 * could rewrite another tree's `.git` file, or swap a tree for a
 * repository of its making, would have git outside run that
 * repository's settings. The folder the trees are cut in and the
 * records of who holds them are read-only inside; each tree the session
 * holds, and the one the command stands in, is bound back writable but
 * for its `.git` file.
 */

import { dirname, join, relative, sep } from "node:path";
import type { Disk } from "./fence-disk.ts";

/** Where the broker cuts its trees and records who holds them, and the trees this session holds. */
export interface BrokerTrees {
	readonly root: string;
	readonly records: string;
	readonly held: readonly string[];
}

/**
 * The trees in the broker's folder a command standing in `cwd` may
 * write: those the session holds and the one it stands in, each a
 * folder directly in it.
 */
function writableTrees(
	trees: BrokerTrees,
	cwd: string | undefined,
	disk: Disk,
): string[] {
	const standing = cwd ? relative(trees.root, cwd).split(sep)[0] : undefined;
	const named =
		standing && standing !== ".." && !standing.startsWith("/")
			? [...trees.held, join(trees.root, standing)]
			: trees.held;
	return [...new Set(named)].filter(
		(tree) => dirname(tree) === trees.root && disk.kind(tree) === "folder",
	);
}

/**
 * bubblewrap's arguments for the broker's trees: the folder and its
 * records read-only, then each tree the command may write bound back,
 * with its `.git` file read-only over it. Nothing, when no broker is named.
 */
export function brokerTreeArgs(
	trees: BrokerTrees | undefined,
	cwd: string | undefined,
	disk: Disk,
): string[] {
	if (!trees || disk.kind(trees.root) !== "folder") return [];
	const args = ["--ro-bind", trees.root, trees.root];
	if (disk.kind(trees.records) === "folder") {
		args.push("--ro-bind", trees.records, trees.records);
	}
	for (const tree of writableTrees(trees, cwd, disk)) {
		args.push("--bind", tree, tree);
		const git = join(tree, ".git");
		if (disk.kind(git) === "file") args.push("--ro-bind", git, git);
	}
	return args;
}

/**
 * Whether the fence keeps pi's own file tools from writing `path` in the
 * broker's trees: anywhere in the records, or in the folder but a tree
 * the command may write, whose `.git` file stays read-only. Nothing,
 * when `path` lies outside both, for the fence's other rules to judge.
 */
export function brokerTreesRefuseWrite(
	path: string,
	trees: BrokerTrees | undefined,
	cwd: string | undefined,
	disk: Disk,
): boolean | undefined {
	if (!trees) return undefined;
	const inside = (folder: string) =>
		path === folder || path.startsWith(`${folder}/`);
	if (inside(trees.records)) return true;
	if (!inside(trees.root)) return undefined;
	return !writableTrees(trees, cwd, disk).some(
		(tree) => inside(tree) && path !== join(tree, ".git"),
	);
}

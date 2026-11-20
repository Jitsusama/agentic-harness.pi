/**
 * Trees standing where the broker cuts them that nothing can use.
 *
 * A tree is found again by its folder's name, so one the broker's
 * record forgot is handed over the next time somebody asks for it, as
 * long as git will read it. One git won't run in can be neither handed
 * over nor cut again, and no checkout's survey lists it: on 20 November
 * a council killed by a host restart left a snapshot cut from a clone
 * outside ~/src, whose settings the fence doesn't guard, and every
 * snapshot of that commit then failed on git's "already exists".
 *
 * Such a tree is set aside whole rather than removed, since git can't
 * be asked whether it holds uncommitted work: moving it frees its name
 * and keeps every file it held.
 */

import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { resolvedPath } from "./in-use.ts";
import { goneGitDir } from "./sweep-orphan.ts";

/** A tree nothing can use, and why git can't read it. */
export interface StrandedTree {
	path: string;
	why: string;
}

/** What is known when asking which trees are stranded. */
export interface StrandedAsk {
	/** The folder the broker cuts its trees in. */
	dir: string;
	/**
	 * Every path something holds, a record, a claim or a checkout's git,
	 * with its links resolved. None of these is stranded, whatever git
	 * says of it: each has an owner who takes it down.
	 */
	kept: ReadonlySet<string>;
	/** Why git won't run in the tree at a path, or nothing when it will. */
	refusal: (path: string) => string | undefined;
}

/** What the sweep names a tree it has moved aside to remove. */
const GOING = ".going-";

/**
 * The trees in the folder the broker cuts them in that nothing holds
 * and git won't read: one whose git folder is gone, or one git is
 * refused in. A folder with no `.git` file is no worktree, so whatever
 * put it there judges it.
 */
export function strandedTrees(ask: StrandedAsk): StrandedTree[] {
	let names: string[];
	try {
		names = readdirSync(ask.dir);
	} catch {
		// No folder yet means no tree was ever cut, so none is stranded.
		return [];
	}
	const stranded: StrandedTree[] = [];
	for (const name of names.sort()) {
		if (name.includes(GOING)) continue;
		const path = join(ask.dir, name);
		if (!isFolder(path) || ask.kept.has(resolvedPath(path))) continue;
		if (!isFile(join(path, ".git"))) continue;
		const gone = goneGitDir(path);
		const why =
			gone === undefined
				? ask.refusal(path)
				: `the git folder its .git names, ${gone}, is gone`;
		if (why !== undefined) stranded.push({ path, why });
	}
	return stranded;
}

/** What became of one stranded tree. */
export type SetAsideTree =
	| { kind: "set-aside"; path: string; aside: string }
	| { kind: "refused"; path: string; why: string };

/** Where stranded trees are set aside: beside the trees' folder, never in it. */
export function strandedDir(treesDir: string): string {
	return join(dirname(treesDir), "stranded");
}

/**
 * Move each stranded tree aside whole, under a name of its own in
 * `into`, and say where each went. A move refused leaves the tree where
 * it was and says why, without holding up the rest.
 */
export function setAside(
	trees: readonly StrandedTree[],
	into: string,
): SetAsideTree[] {
	const done: SetAsideTree[] = [];
	for (const tree of trees) {
		const aside = join(
			into,
			`${basename(tree.path)}-${randomBytes(4).toString("hex")}`,
		);
		try {
			mkdirSync(into, { recursive: true });
			renameSync(tree.path, aside);
			done.push({ kind: "set-aside", path: tree.path, aside });
		} catch (error) {
			done.push({
				kind: "refused",
				path: tree.path,
				why: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return done;
}

function isFolder(path: string): boolean {
	try {
		const stat = lstatSync(path);
		return stat.isDirectory() && !stat.isSymbolicLink();
	} catch {
		// Gone between the listing and now: nothing to judge.
		return false;
	}
}

function isFile(path: string): boolean {
	try {
		return lstatSync(path).isFile();
	} catch {
		// No `.git` here at all.
		return false;
	}
}

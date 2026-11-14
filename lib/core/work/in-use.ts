/**
 * Which recorded trees something is still working in, whatever their
 * records' owners say.
 *
 * An owner names a process, and a session outlives its process: after a
 * restart a resumed session runs in a new one and goes on using its
 * trees by path. Its record then names only the old process, which
 * reads as ended. The sweep took trees from sessions still using them
 * that way until it asked this, and on 10 November `work reclaim`, which
 * didn't, would have taken 59 clean snapshots in one checkout that two
 * running sessions still named (E000B57C). Anything that takes a tree
 * because its owners have ended asks this first.
 */

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { HeldTree, TreeBroker } from "./broker.ts";

/** What tells a tree is in use beyond its record's owners. */
export interface UseSigns {
	/**
	 * The pi sessions running now, by session id. A tree a running
	 * session holds is kept, whichever process that session now runs in.
	 */
	liveSessions?(): Promise<ReadonlySet<string>>;
	/**
	 * The working folders of every process running now. Read without
	 * holding the event loop where it can be, since a shared host's other
	 * conversations wait on it: on 14 November reading them all at once
	 * held it 469 ms.
	 */
	standingIn?(): readonly string[] | Promise<readonly string[]>;
	/**
	 * The working folders of every session that may work in one, wherever
	 * it runs. A hosted conversation's folder is no process's: on 11
	 * November a sweep took one while its host held it open.
	 */
	sessionFolders?(): Promise<readonly string[]>;
	/**
	 * When this boot began, in milliseconds since the epoch. A tree whose
	 * record names no session is kept once its git has moved since then,
	 * since a session that resumed in a new process may be working in it.
	 */
	bootedAt?: number;
}

/**
 * The trees something is working in: one a running session holds, one a
 * running process or a live session stands in, and one with no session
 * named whose git has moved since this boot began.
 */
export async function treesInUse(
	signs: UseSigns,
	trees: readonly HeldTree[],
): Promise<HeldTree[]> {
	const live = (await signs.liveSessions?.()) ?? new Set<string>();
	const standing = [
		...((await signs.standingIn?.()) ?? []),
		...((await signs.sessionFolders?.()) ?? []),
	].map(resolvedPath);
	return trees.filter((tree) => {
		const sessions = Array.isArray(tree.sessions) ? tree.sessions : [];
		if (sessions.some((one) => live.has(one))) return true;
		const path = resolvedPath(tree.path);
		if (standing.some((one) => one === path || one.startsWith(`${path}/`))) {
			return true;
		}
		return (
			sessions.length === 0 &&
			signs.bootedAt !== undefined &&
			gitMovedSince(tree.path, signs.bootedAt)
		);
	});
}

/**
 * The recorded trees a survey keeps as held: those a running owner
 * holds and those something still works in, leaving out the ones no
 * record attributes, which it keeps and says apart.
 */
export async function treesToKeep(
	broker: Pick<TreeBroker, "held" | "stillHeld" | "unattributed">,
	signs: UseSigns,
): Promise<string[]> {
	const unattributed = new Set(broker.unattributed().map((one) => one.path));
	const attributed = (trees: readonly HeldTree[]) =>
		trees.filter((one) => !unattributed.has(one.path));
	const kept = [
		...attributed(await broker.stillHeld()),
		...(await treesInUse(signs, attributed(broker.held()))),
	].map((one) => one.path);
	return [...new Set(kept)];
}

/** A path with its links resolved, as git reports one. */
export function resolvedPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		// Gone from disk: its own name is still the best one for it.
		return path;
	}
}

/** What git rewrites in a tree's own git folder as it is used. */
const MOVES_WITH_USE = ["HEAD", "index", join("logs", "HEAD")] as const;

/**
 * Whether a tree's git has moved since `since`: a checkout, a commit, a
 * fetch into it or a status that refreshed its index. A tree whose
 * checkout is a `src` folder inside it is read there.
 */
function gitMovedSince(path: string, since: number): boolean {
	const checkout = existsSync(join(path, ".git")) ? path : join(path, "src");
	const gitDir = gitDirOf(checkout);
	if (gitDir === undefined) return false;
	return MOVES_WITH_USE.some((one) => {
		try {
			return statSync(join(gitDir, one)).mtimeMs > since;
		} catch {
			// Not every tree has each of these; one missing says nothing.
			return false;
		}
	});
}

/**
 * Whether nothing has moved a tree's HEAD since `since`: no checkout,
 * commit, reset or rebase. The index is left out, since a status from
 * anybody, the sweep's own included, rewrites it without any work
 * being done. A tree whose git can't be found says it has moved, so
 * nothing is taken on a guess.
 */
export function headStillSince(path: string, since: number): boolean {
	const checkout = existsSync(join(path, ".git")) ? path : join(path, "src");
	const gitDir = gitDirOf(checkout);
	if (gitDir === undefined) return false;
	return ["HEAD", join("logs", "HEAD")].every((one) => {
		try {
			return statSync(join(gitDir, one)).mtimeMs <= since;
		} catch {
			// A tree with no reflog has only its HEAD to say when it moved.
			return one !== "HEAD";
		}
	});
}

/**
 * Whether a tree has sat still since `since`: its HEAD and reflog, as
 * {@link headStillSince} reads them, or, with no git to say, the tree's
 * folder and its `src` folder, which change as anything is added to or
 * taken from them.
 */
export function treeStillSince(path: string, since: number): boolean {
	const checkout = existsSync(join(path, ".git")) ? path : join(path, "src");
	if (gitDirOf(checkout) !== undefined) return headStillSince(path, since);
	return [path, checkout].every((one) => {
		try {
			return statSync(one).mtimeMs <= since;
		} catch {
			// A folder that isn't there has nothing in it to have moved.
			return true;
		}
	});
}

/** The git folder of a checkout, whether `.git` is one or points at one. */
function gitDirOf(checkout: string): string | undefined {
	const dotGit = join(checkout, ".git");
	try {
		if (statSync(dotGit).isDirectory()) return dotGit;
		const said = /^gitdir: (.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1];
		return said === undefined ? undefined : resolve(checkout, said.trim());
	} catch {
		// No checkout here, so there is no git to have moved.
		return undefined;
	}
}

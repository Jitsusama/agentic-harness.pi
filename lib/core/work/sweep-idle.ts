/**
 * Choosing the snapshots a live session pinned and left, for the sweep
 * to take back.
 *
 * A snapshot is held while any session it names is open, and a session
 * may stay open for days: on 18 November 45 open sessions held 667
 * snapshots of 30.6 GB, one session 69, each cut for a review or a check
 * long over. A snapshot is a commit checked out, which a session asking
 * for it again gets cut afresh in seconds, so once nothing has used one
 * for {@link IDLE_HELD_MS} it may go whoever holds it.
 *
 * Narrower than the ended sweep on purpose: only a snapshot with no
 * change, staged or not, and no untracked file, whose HEAD is the commit
 * it was pinned at and never left it. Never one a process works in or
 * holds a file open in, one a session's folder lies in, one something
 * claims, or one whose record names nobody, since nothing can say whose
 * that is. Nothing at all where the machine can't say what processes
 * hold, and never one held by a session whose asks don't date its use,
 * as one on older code, until that session ends or asks on newer code.
 */

import { statSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { Exec } from "../exec/index.ts";
import type { HeldTree } from "./broker.ts";
import {
	gitMovedAt,
	resolvedPath as resolved,
	type UseSigns,
} from "./in-use.ts";
import { everyAskDated } from "./memory.ts";
import { pinnedCommit } from "./tree.ts";

/**
 * How long a snapshot a live session holds goes unused before the sweep
 * takes it: past any review or check, which reads its snapshot within
 * the hour it asked for it.
 */
export const IDLE_HELD_MS = 4 * 60 * 60 * 1000;

/**
 * How many such snapshots one sweep takes at most, oldest first, so a
 * sweep's last take is seconds behind the second reading of who works
 * where, and a sweep holds the lock and the host's time for no longer
 * than that many removals.
 */
export const IDLE_TAKES_PER_SWEEP = 20;

/** A snapshot to take, with the commit it was pinned at. */
export interface IdleSnapshot {
	tree: HeldTree;
	commit: string;
	/** When it was last used, in milliseconds since the epoch. */
	usedAt: number;
}

/** What choosing needs beyond the signs of use. */
export interface IdleChoice extends UseSigns {
	exec: Exec;
	/** Paths something says it wants, such as a quest's trees. */
	claims: readonly string[];
	/** The time now, in milliseconds since the epoch. */
	now: number;
}

/**
 * When a tree was last used: the later of a session last asking for it,
 * its git last moving, and its folder last changing. Reading leaves no
 * mark on a disk that keeps no access times, so a session asking for the
 * tree is the mark a reader leaves.
 */
export function lastUsed(tree: HeldTree): number {
	let folder = 0;
	try {
		folder = statSync(tree.path).mtimeMs;
	} catch {
		// Gone from disk: nothing in it to have changed.
	}
	return Math.max(tree.usedAt ?? 0, gitMovedAt(tree.path), folder);
}

/**
 * The snapshots among `held`, which live sessions hold, that nothing has
 * used within {@link IDLE_HELD_MS} and that lose nothing by going, at
 * most {@link IDLE_TAKES_PER_SWEEP} of them, least recently used first.
 */
export async function idleSnapshots(
	held: readonly HeldTree[],
	choice: IdleChoice,
): Promise<IdleSnapshot[]> {
	const since = choice.now - IDLE_HELD_MS;
	const aged = held
		.filter(
			(tree) =>
				tree.providerId === "git-worktree" &&
				Array.isArray(tree.owners) &&
				tree.owners.length > 0 &&
				pinnedCommit(tree.identity) !== undefined &&
				everyAskDated(tree) &&
				lastUsed(tree) <= since,
		)
		.map((tree) => ({
			tree,
			usedAt: lastUsed(tree),
			path: resolved(tree.path),
		}))
		.sort((a, b) => a.usedAt - b.usedAt);
	const claimed = choice.claims.map(resolved);
	const unclaimed = aged.filter(({ path }) => {
		const inside = (one: string) => one === path || one.startsWith(`${path}/`);
		return !claimed.some((one) => inside(one) || path.startsWith(`${one}/`));
	});
	if (unclaimed.length === 0) return [];
	// Read before the cap too, so trees kept busy for days never fill it
	// and starve every other.
	const busyBefore = await choice.busyAmong?.(
		unclaimed.map(({ path }) => path),
	);
	if (busyBefore === undefined) return [];
	const chosen: IdleSnapshot[] = [];
	for (const { tree, usedAt, path } of unclaimed) {
		if (chosen.length >= IDLE_TAKES_PER_SWEEP) break;
		if (busyBefore.has(path)) continue;
		const commit = pinnedCommit(tree.identity);
		if (
			commit === undefined ||
			!(await untouched(choice.exec, tree.path, commit))
		) {
			continue;
		}
		chosen.push({ tree, commit, usedAt });
	}
	if (chosen.length === 0) return [];
	// Read again once the choosing is done, so it is seconds old at each
	// take.
	const busy = await choice.busyAmong?.(
		chosen.map(({ tree }) => resolved(tree.path)),
	);
	if (busy === undefined) return [];
	return chosen.filter(({ tree }) => !busy.has(resolved(tree.path)));
}

/**
 * Whether a snapshot is as it was cut: no change, staged or not, no
 * untracked file, and its HEAD at its pin with a reflog naming nothing
 * else, since a commit made there and left is held by that reflog alone.
 * The status takes no optional locks, so it leaves the index as it was
 * rather than marking the tree used.
 */
async function untouched(
	exec: Exec,
	path: string,
	commit: string,
): Promise<boolean> {
	const git = (...args: string[]) =>
		exec("git", ["-C", path, "--no-optional-locks", ...args]);
	const status = await git("status", "--porcelain=v1", "--untracked-files=all");
	if (status.code !== 0 || status.stdout.trim() !== "") return false;
	const head = await git("rev-parse", "HEAD");
	if (head.code !== 0 || head.stdout.trim() !== commit) return false;
	const reflog = await git("reflog", "--format=%H", "HEAD");
	const been = reflog.stdout.split("\n").filter((line) => line !== "");
	return (
		reflog.code === 0 &&
		been.length > 0 &&
		been.every((line) => line === commit)
	);
}

/** The main checkout of the repository a tree was cut from, when git can say. */
export async function mainCheckoutOf(
	exec: Exec,
	path: string,
): Promise<string | undefined> {
	const common = await exec("git", [
		"-C",
		path,
		"rev-parse",
		"--path-format=absolute",
		"--git-common-dir",
	]);
	if (common.code !== 0) return undefined;
	const dir = common.stdout.trim();
	return basename(dir) === ".git" ? dirname(dir) : dir;
}

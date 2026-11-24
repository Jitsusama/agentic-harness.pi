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
 * that is; nor one git would refuse to remove, locked or holding
 * submodules, which would fill the takes every sweep. Nothing at all
 * where the machine can't say what processes hold.
 *
 * A session's ask is dated by its record's own file as well as its
 * `usedAt`, since every session on any code rewrites the record on every
 * ask, and one on code from before the dating carries a stale `usedAt`.
 */

import { existsSync, lstatSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { GIT_REFUSED } from "../../internal/sandbox/tree-git.ts";
import type { Exec } from "../exec/index.ts";
import type { HeldTree } from "./broker.ts";
import {
	gitMovedAt,
	resolvedPath as resolved,
	type UseSigns,
} from "./in-use.ts";
import { pinnedCommit } from "./tree.ts";

/**
 * How long a snapshot a live session holds goes unused before the sweep
 * takes it: past any review or check, which reads its snapshot within
 * the hour it asked for it.
 */
export const IDLE_HELD_MS = 4 * 60 * 60 * 1000;

/**
 * How long a worktree a live session holds goes unused before the sweep
 * takes it, once nothing is only there: a day, past a session's working
 * day, since a worktree is where its session writes and comes back to.
 */
export const IDLE_WORKTREE_MS = 24 * 60 * 60 * 1000;

/**
 * How many such snapshots one sweep takes at most, oldest first, unless
 * its caller says otherwise, so a sweep on a host's thread holds the
 * lock and the host's time for no longer than that many removals. Who
 * works where is read again for each, just before its take.
 */
export const IDLE_TAKES_PER_SWEEP = 20;

/** A snapshot to take, with the commit it was pinned at. */
export interface IdleSnapshot {
	tree: HeldTree;
	commit: string;
	/** When it was last used, in milliseconds since the epoch. */
	usedAt: number;
}

/**
 * A worktree to take, with the branch it is on, its head and the remote
 * branch holding that head.
 */
export interface IdleWorktree {
	tree: HeldTree;
	branch: string;
	commit: string;
	/** The remote-tracking branch holding its head, as `origin/main`. */
	remote: string;
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
	/**
	 * When a tree's record was last written, as the memory says, read
	 * from the record `key` names when it is given.
	 */
	askedAt(path: string, key?: string): number | undefined;
	/** How many to take at most; {@link IDLE_TAKES_PER_SWEEP} by default. */
	most?: number;
	/**
	 * Whether the sweep has run as long as it may take these for, asked
	 * before each is judged once {@link IDLE_TAKES_PER_SWEEP} have been
	 * given, so a sweep that may take more never takes fewer than a host
	 * would; never, by default.
	 */
	spent?(): boolean;
	/**
	 * Told how many aged, unclaimed snapshots nothing was seen working in
	 * were left unjudged, when `most` or `spent` stopped the choosing with
	 * any left, so a sweep can say a backlog remains. Judging may yet
	 * refuse some of them, as one holding changes.
	 */
	left?(count: number): void;
}

/**
 * When a tree was last used: the latest of a session last asking for it,
 * by its `usedAt` or `asked`, when its record was last written, its git
 * last moving, and its folder last changing. Reading leaves no mark on a
 * disk that keeps no access times, so a session asking for the tree is
 * the mark a reader leaves. A record nobody can date reads as used now.
 */
export function lastUsed(tree: HeldTree, asked: number | undefined): number {
	if (asked === undefined) return Number.POSITIVE_INFINITY;
	let folder = 0;
	try {
		folder = statSync(tree.path).mtimeMs;
	} catch {
		// Gone from disk: nothing in it to have changed.
	}
	return Math.max(tree.usedAt ?? 0, asked, gitMovedAt(tree.path), folder);
}

/**
 * The snapshots {@link eachIdleSnapshot} gives, all of them chosen
 * before any is taken.
 */
export async function idleSnapshots(
	held: readonly HeldTree[],
	choice: IdleChoice,
): Promise<IdleSnapshot[]> {
	const chosen: IdleSnapshot[] = [];
	for await (const idle of eachIdleSnapshot(held, choice)) chosen.push(idle);
	return chosen;
}

/**
 * The snapshots among `held`, which live sessions hold, that nothing has
 * used within {@link IDLE_HELD_MS} and that lose nothing by going, at
 * most `choice.most` of them, least recently used first. Each is judged
 * only once the one before it has been dealt with, so a sweep can take
 * each as it comes and time spent judging is never lost to the takes.
 * Throws when there are some to judge and the machine can't say which
 * processes hold them, so the sweep says why it took none.
 */
export async function* eachIdleSnapshot(
	held: readonly HeldTree[],
	choice: IdleChoice,
): AsyncGenerator<IdleSnapshot> {
	const since = choice.now - IDLE_HELD_MS;
	const aged = held
		.filter(
			(tree) =>
				tree.providerId === "git-worktree" &&
				Array.isArray(tree.owners) &&
				tree.owners.length > 0 &&
				pinnedCommit(tree.identity) !== undefined,
		)
		.map((tree) => ({
			tree,
			usedAt: lastUsed(tree, choice.askedAt(tree.path, tree.identity.key)),
			path: resolved(tree.path),
		}))
		.filter(({ usedAt }) => usedAt <= since)
		.sort((a, b) => a.usedAt - b.usedAt);
	const claimed = choice.claims.map(resolved);
	const unclaimed = aged.filter(({ path }) => {
		const inside = (one: string) => one === path || one.startsWith(`${path}/`);
		return !claimed.some((one) => inside(one) || path.startsWith(`${one}/`));
	});
	if (unclaimed.length === 0) return;
	// Read before the cap too, so trees kept busy for days never fill it
	// and starve every other.
	const busyBefore = await choice.busyAmong?.(
		unclaimed.map(({ path }) => path),
	);
	if (busyBefore === undefined)
		throw new Error("the machine can't say which processes hold its trees");
	const most = choice.most ?? IDLE_TAKES_PER_SWEEP;
	const floor = Math.min(most, IDLE_TAKES_PER_SWEEP);
	let given = 0;
	const leaving = (at: number): void => {
		const left = unclaimed
			.slice(at)
			.filter(({ path }) => !busyBefore.has(path)).length;
		if (left > 0) choice.left?.(left);
	};
	for (const [at, { tree, usedAt, path }] of unclaimed.entries()) {
		if (given >= most || (given >= floor && choice.spent?.() === true)) {
			leaving(at);
			return;
		}
		if (busyBefore.has(path)) continue;
		const commit = pinnedCommit(tree.identity);
		if (
			commit === undefined ||
			!(await untouched(choice.exec, tree.path, commit))
		) {
			continue;
		}
		given += 1;
		yield { tree, commit, usedAt };
	}
}

/**
 * The worktrees among `held`, which live sessions hold, that nothing has
 * used within {@link IDLE_WORKTREE_MS} and that hold nothing found only
 * there, at most `choice.most` of them, least recently used first, each
 * judged once the one before it has been dealt with. Kept by every rule
 * a snapshot is kept by (a process working in it, a claim, a session's
 * folder in it), and also when its record names no session to tell and
 * keep its branch for, or it has a change, an untracked file, an ignored
 * file, a stash on its branch, a head no remote-tracking branch holds, a
 * commit only its own HEAD's reflog holds, or no branch checked out.
 * Throws, as {@link eachIdleSnapshot} does, when the machine can't say
 * which processes hold them.
 */
export async function* eachIdleWorktree(
	held: readonly HeldTree[],
	choice: IdleChoice,
): AsyncGenerator<IdleWorktree> {
	const since = choice.now - IDLE_WORKTREE_MS;
	const claimed = choice.claims.map(resolved);
	const aged = held
		.filter(
			(tree) =>
				tree.providerId === "git-worktree" &&
				!tree.identity.shareable &&
				Array.isArray(tree.owners) &&
				tree.owners.length > 0 &&
				Array.isArray(tree.sessions) &&
				tree.sessions.length > 0,
		)
		.map((tree) => ({
			tree,
			usedAt: lastUsed(tree, choice.askedAt(tree.path, tree.identity.key)),
			path: resolved(tree.path),
		}))
		.filter(({ usedAt }) => usedAt <= since)
		.filter(({ path }) => {
			const inside = (one: string) =>
				one === path || one.startsWith(`${path}/`);
			return !claimed.some((one) => inside(one) || path.startsWith(`${one}/`));
		})
		.sort((a, b) => a.usedAt - b.usedAt);
	if (aged.length === 0) return;
	const busy = await choice.busyAmong?.(aged.map(({ path }) => path));
	if (busy === undefined) {
		throw new Error("the machine can't say which processes hold its trees");
	}
	const most = choice.most ?? IDLE_TAKES_PER_SWEEP;
	const floor = Math.min(most, IDLE_TAKES_PER_SWEEP);
	let given = 0;
	for (const [at, { tree, usedAt, path }] of aged.entries()) {
		if (given >= most || (given >= floor && choice.spent?.() === true)) {
			const left = aged.slice(at).filter((one) => !busy.has(one.path)).length;
			if (left > 0) choice.left?.(left);
			return;
		}
		if (busy.has(path)) continue;
		const settled = await nothingOnlyHere(choice.exec, tree.path);
		if (settled === undefined) continue;
		given += 1;
		yield { tree, usedAt, ...settled };
	}
}

/**
 * The branch, head and remote branch of a worktree that holds nothing
 * found only there: on a branch, its head on some remote-tracking
 * branch, with no change, staged or not, no untracked or ignored file,
 * no stash made on that branch, and no commit its own HEAD's reflog
 * alone holds, as one made there and reset away. An ignored folder is
 * build output made again, but an ignored file may be a `.env` or notes
 * nobody pushed. Not one git refuses to remove. The status, read last as
 * the dearest, takes no optional locks.
 */
export async function nothingOnlyHere(
	exec: Exec,
	path: string,
): Promise<{ branch: string; commit: string; remote: string } | undefined> {
	const git = (...args: string[]) =>
		exec("git", ["-C", path, "--no-optional-locks", ...args]);
	const branch = await git("symbolic-ref", "--quiet", "--short", "HEAD");
	const head = await git("rev-parse", "HEAD");
	if (branch.code !== 0 || head.code !== 0) return undefined;
	const name = branch.stdout.trim();
	const commit = head.stdout.trim();
	const holding = await git(
		"for-each-ref",
		`--contains=${commit}`,
		"--format=%(refname:short)",
		"refs/remotes",
	);
	// Its own remote branch is named first, as the place to find it; a
	// remote's HEAD, which git shortens to the remote's bare name, only
	// repeats its default branch.
	const remotes = holding.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.includes("/") && !line.endsWith("/HEAD"));
	const remote = remotes.find((one) => one.endsWith(`/${name}`)) ?? remotes[0];
	if (holding.code !== 0 || remote === undefined) return undefined;
	// The stash is the repository's, shared by every tree; git names the
	// branch each entry was made on in its message.
	const stashes = await git("stash", "list", "--format=%gs");
	if (
		stashes.code !== 0 ||
		stashes.stdout
			.split("\n")
			.some((line) => /^(?:WIP on|On) (.+?):/.exec(line)?.[1] === name)
	) {
		return undefined;
	}
	const own = await git("rev-parse", "--absolute-git-dir");
	if (
		own.code !== 0 ||
		existsSync(join(own.stdout.trim(), "locked")) ||
		existsSync(join(path, ".gitmodules"))
	) {
		return undefined;
	}
	if (!(await reflogHeldElsewhere(git))) return undefined;
	const status = await git(
		"status",
		"--porcelain=v1",
		"--untracked-files=all",
		"--ignored=matching",
	);
	if (
		status.code !== 0 ||
		status.stdout
			.split("\n")
			.some((line) => line !== "" && !madeAgain(path, line))
	) {
		return undefined;
	}
	return { branch: name, commit, remote };
}

/**
 * Whether a line of `git status --ignored=matching` names what a build
 * makes again: an ignored folder, as `node_modules/` or `target/`, or an
 * ignored link, as Nix's `result`. Anything else, a change, an untracked
 * file or an ignored plain file, is work found only there.
 */
function madeAgain(tree: string, line: string): boolean {
	const ignored = /^!! (.+)$/.exec(line)?.[1];
	if (ignored === undefined) return false;
	if (ignored.endsWith("/")) return true;
	try {
		return lstatSync(join(tree, ignored)).isSymbolicLink();
	} catch {
		// Gone, or a name git quoted: kept, as nothing says it can be made.
		return false;
	}
}

/**
 * The most commits a worktree's HEAD reflog is judged by; one that has
 * been at more is kept rather than read further.
 */
const REFLOG_MOST = 2000;

/**
 * Whether every commit a worktree's HEAD has been at is held by some
 * branch or remote-tracking branch, so nothing goes with its reflog.
 */
async function reflogHeldElsewhere(
	git: (...args: string[]) => Promise<{ code: number; stdout: string }>,
): Promise<boolean> {
	const reflog = await git("reflog", "--format=%H", "HEAD");
	if (reflog.code !== 0) return false;
	const been = [
		...new Set(reflog.stdout.split("\n").filter((line) => line !== "")),
	];
	if (been.length === 0) return true;
	if (been.length > REFLOG_MOST) return false;
	const alone = await git(
		"rev-list",
		"--max-count=1",
		...been,
		"--not",
		"--branches",
		"--remotes",
	);
	return alone.code === 0 && alone.stdout.trim() === "";
}

/**
 * Whether a snapshot is as it was cut: no change, staged or not, no
 * untracked file, and its HEAD at its pin with a reflog naming nothing
 * else, since a commit made there and left is held by that reflog alone.
 * Not one git refuses to remove: locked, or holding submodules. The
 * status, read last as the dearest, takes no optional locks, so it
 * leaves the index as it was rather than marking the tree used.
 */
async function untouched(
	exec: Exec,
	path: string,
	commit: string,
): Promise<boolean> {
	const git = (...args: string[]) =>
		exec("git", ["-C", path, "--no-optional-locks", ...args]);
	const head = await git("rev-parse", "HEAD");
	if (head.code !== 0 || head.stdout.trim() !== commit) return false;
	const reflog = await git("reflog", "--format=%H", "HEAD");
	const been = reflog.stdout.split("\n").filter((line) => line !== "");
	if (
		reflog.code !== 0 ||
		been.length === 0 ||
		been.some((line) => line !== commit)
	) {
		return false;
	}
	const own = await git("rev-parse", "--absolute-git-dir");
	if (
		own.code !== 0 ||
		existsSync(join(own.stdout.trim(), "locked")) ||
		existsSync(join(path, ".gitmodules"))
	) {
		return false;
	}
	const status = await git("status", "--porcelain=v1", "--untracked-files=all");
	return status.code === 0 && status.stdout.trim() === "";
}

/** The main checkout of the repository a tree was cut from, when git can say. */
export async function mainCheckoutOf(
	exec: Exec,
	path: string,
): Promise<string | undefined> {
	const found = await checkoutOf(exec, path);
	return "main" in found ? found.main : undefined;
}

/**
 * The main checkout of the repository a tree was cut from, or why git
 * couldn't say: pi refused to run git there, as it does in a tree whose
 * repository the fence doesn't guard, or git ran and failed.
 */
export async function checkoutOf(
	exec: Exec,
	path: string,
): Promise<{ main: string } | { unread: "refused" | "failed" }> {
	const common = await exec("git", [
		"-C",
		path,
		"rev-parse",
		"--path-format=absolute",
		"--git-common-dir",
	]);
	if (common.code === GIT_REFUSED) return { unread: "refused" };
	if (common.code !== 0) return { unread: "failed" };
	const dir = common.stdout.trim();
	return { main: basename(dir) === ".git" ? dirname(dir) : dir };
}

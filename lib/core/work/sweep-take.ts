/**
 * Taking a linked worktree without a git command that reads every
 * worktree its repository has.
 *
 * `git worktree move` and `git worktree remove` each list every worktree
 * before acting on one: on 22 November, with 2,061 in one repository,
 * they took 29 s and 19 s a take, so a sweep took 20 of the 1,800
 * waiting and each take was slower than the last. So the tree is moved
 * aside as git's move would, renaming it and pointing its git folder at
 * the new place, then removed with that folder, as git's remove would,
 * after the same checks git's remove makes: that git hasn't locked it,
 * that its git folder and its `.git` file name each other, that it holds
 * no submodule, and that `git status` finds nothing in it.
 *
 * One per-tree command still reads every worktree: `git branch -D`, which
 * drops a taken tree's branch once trunk holds it. Idle snapshots are
 * detached and never reach it; an ended tree on a merged branch does.
 *
 * A tree's `.git` file, and every file it names, is anybody's to write
 * who ran in the tree, so each is read with {@link readPlain}, and the
 * folder removed must be one of the repository's own, in its `worktrees`.
 */

import { randomBytes } from "node:crypto";
import {
	closeSync,
	lstatSync,
	openSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { removeTreeOff } from "../../internal/files/remove-tree.ts";
import type { Exec } from "../exec/index.ts";
import { readPlain } from "./plain-file.ts";
import { plainWords } from "./stranded.ts";

/**
 * A tree moved aside, the git folder its repository keeps for it, and
 * what that folder's way back to it said before the move.
 */
export interface MovedAside {
	aside: string;
	gitDir: string;
	back: string;
}

/**
 * Move the tree at `path`, a worktree of the repository whose main
 * checkout is `main`, to `aside`, unless git would refuse to remove it
 * there. Its git folder then names `aside`, as git's move leaves it, so
 * git reads the tree there, and a tree cut at `path` meanwhile gets a git
 * folder of its own. Says why when it is left where it was.
 */
export function moveAside(
	path: string,
	aside: string,
	main: string,
): MovedAside | string {
	const linked = linkedGitDir(path, main);
	if ("why" in linked) return linked.why;
	const { gitDir, back } = linked;
	const locked = join(gitDir, "locked");
	if (present(locked)) {
		const reason = plainWords(readPlain(locked) ?? "");
		return reason === "" ? "git has it locked" : `git has it locked: ${reason}`;
	}
	if (isDirectory(join(gitDir, "modules"))) return "it holds submodules";
	try {
		renameSync(path, aside);
	} catch (error) {
		return messageOf(error);
	}
	try {
		nameIn(gitDir, `${join(aside, ".git")}\n`);
	} catch (error) {
		const why = `git's folder for it can't name it aside: ${messageOf(error)}`;
		try {
			renameSync(aside, path);
		} catch (again) {
			return `${why}; it is left at ${aside}: ${messageOf(again)}`;
		}
		return why;
	}
	return { aside, gitDir, back };
}

/**
 * Why git would keep the tree moved aside, as its remove does without
 * `--force`, or nothing when it may go: a submodule checked out in it,
 * or anything `git status` says, untracked files included whatever the
 * repository's settings would hide.
 */
export async function whyGitKeeps(
	exec: Exec,
	aside: string,
): Promise<string | undefined> {
	// Split on NUL, since git quotes a path it would print oddly otherwise,
	// and a quoted name finds no submodule's `.git` beneath it.
	const staged = await exec("git", ["-C", aside, "ls-files", "--stage", "-z"]);
	if (staged.code !== 0) return said(staged);
	for (const entry of staged.stdout.split("\0")) {
		const tab = entry.indexOf("\t");
		if (!entry.startsWith("160000 ") || tab < 0) continue;
		if (present(join(aside, entry.slice(tab + 1), ".git"))) {
			return "it holds submodules";
		}
	}
	// No optional locks, so git reads the index rather than refreshing
	// and writing it back: a tree that may go needs no write, and one
	// kept and put back is left as its session had it. Git still reads
	// any file whose stat the index doesn't match, so a change shows.
	const status = await exec("git", [
		"-C",
		aside,
		"--no-optional-locks",
		"status",
		"--porcelain",
		"--ignore-submodules=none",
		"--untracked-files=normal",
	]);
	if (status.code !== 0) return said(status);
	return status.stdout.trim() === ""
		? undefined
		: "it contains modified or untracked files";
}

/** Where a put-back left the tree, and what went wrong on the way. */
export interface PutBack {
	/** Whether the tree is at its own path again. */
	home: boolean;
	why?: string;
}

/**
 * Put a tree moved aside back where it was, its git folder naming it
 * there again. Anything at its path by now, even an empty folder a cut
 * is starting in, keeps it aside, as git's move refuses to land on one;
 * rename alone would replace an empty folder.
 */
export function putBack(moved: MovedAside, path: string): PutBack {
	if (present(path)) {
		return {
			home: false,
			why: `it is left at ${moved.aside}: something stands at ${path} now`,
		};
	}
	try {
		renameSync(moved.aside, path);
	} catch (error) {
		return {
			home: false,
			why: `it is left at ${moved.aside}: ${messageOf(error)}`,
		};
	}
	try {
		nameIn(moved.gitDir, moved.back);
	} catch (error) {
		return {
			home: true,
			why: `it is back, but its git folder still names ${moved.aside}: ${messageOf(error)}`,
		};
	}
	return { home: true };
}

/**
 * Write `back` as the way from git's folder `gitDir` to its tree, whole
 * or not at all: a write cut short on a full disk would leave git a
 * folder naming nothing, which its prune takes at once. The folder is
 * writable from inside the tree's fence, so the new file is made under a
 * name nobody can guess and only if nothing stands there, never through
 * a link a session left, as git's own lockfile is.
 */
function nameIn(gitDir: string, back: string): void {
	const next = join(gitDir, `gitdir.${randomBytes(8).toString("hex")}.new`);
	const fd = openSync(next, "wx");
	try {
		try {
			writeSync(fd, back);
		} finally {
			closeSync(fd);
		}
		renameSync(next, join(gitDir, "gitdir"));
	} catch (error) {
		rmSync(next, { force: true });
		throw error;
	}
}

/**
 * Remove a tree moved aside, then the git folder its repository keeps
 * for it, as git's remove does; nothing when both went, else what stays
 * and why. What is left of a tree that won't all go stays aside, and its
 * git folder goes all the same, so git lists it no more, as git's remove
 * leaves it. A git folder that no longer names the aside belongs to some
 * other tree by now, so it stays.
 */
export async function removeAside(
	moved: MovedAside,
): Promise<string | undefined> {
	const stays: string[] = [];
	try {
		await removeTreeOff(moved.aside);
	} catch (error) {
		stays.push(`${messageOf(error)}; what is left is at ${moved.aside}`);
	}
	const names = readPlain(join(moved.gitDir, "gitdir"))?.trim();
	if (
		names === undefined ||
		resolve(moved.gitDir, names) !== join(moved.aside, ".git")
	) {
		stays.push(
			`its git folder ${moved.gitDir} no longer names it, so it stays`,
		);
		return stays.join("; ");
	}
	try {
		await removeTreeOff(moved.gitDir);
	} catch (error) {
		stays.push(`its git folder ${moved.gitDir} stays: ${messageOf(error)}`);
	}
	return stays.length === 0 ? undefined : stays.join("; ");
}

/**
 * The git folder a linked worktree at `path` names, with what its way
 * back says, when that folder is one of `main`'s repository's own and
 * names the tree back, as git's own check before a remove asks; else why
 * not.
 */
function linkedGitDir(
	path: string,
	main: string,
): { gitDir: string; back: string } | { why: string } {
	const pointer = readPlain(join(path, ".git"))?.trim();
	if (pointer === undefined) return { why: "it has no plain .git file" };
	if (!pointer.startsWith("gitdir:")) {
		return { why: "it isn't a linked worktree" };
	}
	const gitDir = resolve(path, pointer.slice("gitdir:".length).trim());
	const common = commonOf(main);
	const named = readPlain(join(gitDir, "commondir"))?.trim();
	if (
		basename(dirname(gitDir)) !== "worktrees" ||
		real(dirname(dirname(gitDir))) !== real(common) ||
		named === undefined ||
		real(resolve(gitDir, named)) !== real(common)
	) {
		return {
			why: `its .git file names ${plainWords(gitDir)}, which isn't a worktree's folder in ${plainWords(common)}`,
		};
	}
	const back = readPlain(join(gitDir, "gitdir"));
	if (back === undefined) return { why: "git's folder for it can't be read" };
	if (real(resolve(gitDir, back.trim())) !== real(join(path, ".git"))) {
		return {
			why: `git's folder for it names ${plainWords(dirname(resolve(gitDir, back.trim())))}`,
		};
	}
	return { gitDir, back };
}

/** The git folder of the repository whose main checkout is `main`. */
function commonOf(main: string): string {
	const dotGit = join(main, ".git");
	return isDirectory(dotGit) ? dotGit : main;
}

/** `path` with its links resolved, or as given when it can't be. */
function real(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

function present(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/** What git said when it refused, in its own words, as one plain line. */
function said(result: { stdout: string; stderr: string }): string {
	return plainWords(
		(result.stderr.trim() || result.stdout.trim()).replace(/^fatal: /, ""),
	);
}

function messageOf(error: unknown): string {
	return plainWords(error instanceof Error ? error.message : String(error));
}

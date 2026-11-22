/**
 * Taking a linked worktree without a git command that reads every
 * worktree its repository has.
 *
 * `git worktree move` and `git worktree remove` each list every worktree
 * before acting on one: on 22 November, with 2,061 in one repository,
 * they took 29 s and 19 s a take, so a sweep took 20 of the 1,800
 * waiting and each take was slower than the last. So the tree is
 * renamed aside and removed with its own git folder, as git's remove
 * would, after the same checks git's remove makes: that git hasn't
 * locked it, that its git folder and its `.git` file name each other,
 * that it holds no submodule, and that `git status` finds nothing in it.
 */

import {
	existsSync,
	readFileSync,
	realpathSync,
	renameSync,
	statSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Exec } from "../exec/index.ts";

/** A tree moved aside, and the git folder its repository keeps for it. */
export interface MovedAside {
	aside: string;
	gitDir: string;
}

/**
 * Move the tree at `path` to `aside`, unless git would refuse to remove
 * it there. Says why when it is left where it was.
 */
export function moveAside(path: string, aside: string): MovedAside | string {
	const linked = linkedGitDir(path);
	if ("why" in linked) return linked.why;
	const { gitDir } = linked;
	const locked = join(gitDir, "locked");
	if (existsSync(locked)) {
		const reason = readFileSync(locked, "utf8").trim();
		return reason === "" ? "git has it locked" : `git has it locked: ${reason}`;
	}
	if (isDirectory(join(gitDir, "modules"))) return "it holds submodules";
	try {
		renameSync(path, aside);
	} catch (error) {
		return messageOf(error);
	}
	return { aside, gitDir };
}

/**
 * Why git would keep the tree moved aside, as its remove does without
 * `--force`, or nothing when it may go: a submodule checked out in it,
 * or anything `git status` says, untracked files included.
 */
export async function whyGitKeeps(
	exec: Exec,
	aside: string,
): Promise<string | undefined> {
	const staged = await exec("git", ["-C", aside, "ls-files", "--stage"]);
	if (staged.code !== 0) return said(staged);
	for (const line of staged.stdout.split("\n")) {
		const name = line.split("\t")[1];
		if (
			line.startsWith("160000 ") &&
			name &&
			existsSync(join(aside, name, ".git"))
		) {
			return "it holds submodules";
		}
	}
	const status = await exec("git", [
		"-C",
		aside,
		"status",
		"--porcelain",
		"--ignore-submodules=none",
	]);
	if (status.code !== 0) return said(status);
	return status.stdout.trim() === ""
		? undefined
		: "it contains modified or untracked files";
}

/** Put a tree moved aside back where it was. */
export function putBack(moved: MovedAside, path: string): void {
	renameSync(moved.aside, path);
}

/**
 * Remove a tree moved aside, then the git folder its repository keeps
 * for it, as git's remove does: what is left of a tree that won't all go
 * stays aside, said, and its git folder goes all the same, so git lists
 * it no more.
 */
export async function removeAside(
	moved: MovedAside,
): Promise<string | undefined> {
	let left: string | undefined;
	try {
		await rm(moved.aside, { recursive: true, force: true });
	} catch (error) {
		left = messageOf(error);
	}
	await rm(moved.gitDir, { recursive: true, force: true });
	return left;
}

/**
 * The git folder a linked worktree at `path` names, when that folder
 * names it back, as git's own check before a remove asks; else why not.
 */
function linkedGitDir(path: string): { gitDir: string } | { why: string } {
	let pointer: string;
	try {
		pointer = readFileSync(join(path, ".git"), "utf8").trim();
	} catch (error) {
		return { why: `its .git file can't be read: ${messageOf(error)}` };
	}
	if (!pointer.startsWith("gitdir:"))
		return { why: "it isn't a linked worktree" };
	const gitDir = resolve(path, pointer.slice("gitdir:".length).trim());
	let back: string;
	try {
		back = readFileSync(join(gitDir, "gitdir"), "utf8").trim();
	} catch (error) {
		return { why: `git's folder for it can't be read: ${messageOf(error)}` };
	}
	if (real(resolve(gitDir, back)) !== real(join(path, ".git"))) {
		return {
			why: `git's folder for it names ${dirname(resolve(gitDir, back))}`,
		};
	}
	return { gitDir };
}

/** `path` with its links resolved, or as given when it can't be. */
function real(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/** What git said when it refused, in its own words. */
function said(result: { stdout: string; stderr: string }): string {
	return (result.stderr.trim() || result.stdout.trim()).replace(/^fatal: /, "");
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

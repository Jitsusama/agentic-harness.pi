/**
 * Where a path's work lives, and whether a tree has changed.
 *
 * Verification ran in the directory the session started in, which is
 * not where the work is when it happens in a worktree. These answer
 * which repository a path belongs to, and give a tree a fingerprint so
 * a check run's verdict is only trusted while the tree is the one it
 * judged.
 *
 * Git is asked off the thread: a host runs many conversations on one
 * thread, and a git status over a large tree, or one waiting on a lock,
 * held every one of them for as long as it took.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { gitRules } from "../../lib/internal/sandbox/sandbox.ts";
import { gitRun } from "../../lib/internal/sandbox/tree-git.ts";

/** How long one git question may take before it counts as unanswered. */
const GIT_WALL_MS = 5_000;

/** The directory a path names: itself when a directory, else its parent. */
export function directoryOf(path: string): string {
	const absolute = resolve(path);
	try {
		if (statSync(absolute).isDirectory()) return absolute;
	} catch {
		// Missing: a file about to be written, so its parent is the place.
	}
	return dirname(absolute);
}

/** The top of the git repository holding dir, or undefined outside one. */
export async function gitRoot(dir: string): Promise<string | undefined> {
	const out = await git(dir, ["rev-parse", "--show-toplevel"]);
	return out === undefined ? undefined : out.trim() || undefined;
}

/** Whether path is root or lies inside it, with links resolved. */
export function within(root: string, path: string): boolean {
	const r = canonical(root);
	const p = canonical(path);
	return p === r || p.startsWith(r.endsWith(sep) ? r : r + sep);
}

/**
 * A fingerprint of what a tree holds: the commit it sits on, and the
 * size and modification time of every file that differs from it,
 * untracked ones included. Staging leaves it alone, since it moves no
 * file. Undefined outside git or when git does not answer in time.
 */
export async function treeFingerprint(
	root: string,
): Promise<string | undefined> {
	const [head, status, top] = await Promise.all([
		git(root, ["rev-parse", "HEAD^{tree}"]),
		git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
		gitRoot(root),
	]);
	if (status === undefined) return undefined;
	const files = await Promise.all(
		changedPaths(status).map((path) => stamped(top ?? root, path)),
	);
	return createHash("sha1")
		.update((head ?? "no-commit").trim())
		.update("\n")
		.update(files.sort().join("\n"))
		.digest("hex");
}

/** A changed path with its size and modification time, or as gone. */
async function stamped(top: string, path: string): Promise<string> {
	try {
		const s = await lstat(join(top, path));
		return `${path}\t${s.size}\t${s.mtimeMs}`;
	} catch {
		// Deleted, or gone since git named it: its absence is what changed.
		return `${path}\tgone`;
	}
}
/** The paths `git status --porcelain -z` names, renames' sources aside. */
function changedPaths(status: string): string[] {
	const tokens = status.split("\0").filter((t) => t.length > 0);
	const paths: string[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const entry = tokens[i] ?? "";
		paths.push(entry.slice(3));
		// A rename or copy carries its source as the next token.
		if (entry[0] === "R" || entry[0] === "C") i++;
	}
	return paths;
}

function canonical(path: string): string {
	const absolute = resolve(path);
	if (existsSync(absolute)) return realpathSync(absolute);
	// Not there yet: resolve the part that is, so a link above it still
	// compares equal to the same directory reached the long way.
	const parent = dirname(absolute);
	if (parent === absolute) return absolute;
	return join(canonical(parent), absolute.slice(parent.length + 1));
}

/** What git prints for `args` in `cwd`, or undefined when it gives no answer. */
function git(
	cwd: string,
	args: readonly string[],
): Promise<string | undefined> {
	// Outside any sandbox, so held to where a sandboxed command couldn't
	// have set what git runs (tree-git.ts).
	const run = gitRun(cwd, args, gitRules());
	if ("refused" in run) return Promise.resolve(undefined);
	return new Promise((answer) => {
		const child = execFile(
			"git",
			run.args,
			{ cwd, encoding: "utf8", timeout: GIT_WALL_MS },
			// Not a repository, git missing, or out of time: no answer.
			(error, stdout) => answer(error ? undefined : stdout),
		);
		child.stdin?.end();
	});
}

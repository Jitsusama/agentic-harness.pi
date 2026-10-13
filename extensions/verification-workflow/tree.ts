/**
 * Where a path's work lives, and whether a tree has changed.
 *
 * Verification ran in the directory the session started in, which is
 * not where the work is when it happens in a worktree. These answer
 * which repository a path belongs to, and give a tree a fingerprint so
 * a check run's verdict is only trusted while the tree is the one it
 * judged.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

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
export function gitRoot(dir: string): string | undefined {
	const out = git(dir, ["rev-parse", "--show-toplevel"]);
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
export function treeFingerprint(root: string): string | undefined {
	const head = git(root, ["rev-parse", "HEAD^{tree}"]) ?? "no-commit";
	const status = git(root, [
		"status",
		"--porcelain=v1",
		"-z",
		"--untracked-files=all",
	]);
	if (status === undefined) return undefined;
	const top = gitRoot(root) ?? root;
	const files = changedPaths(status).map((path) => {
		try {
			const s = lstatSync(join(top, path));
			return `${path}\t${s.size}\t${s.mtimeMs}`;
		} catch {
			return `${path}\tgone`;
		}
	});
	return createHash("sha1")
		.update(head.trim())
		.update("\n")
		.update(files.sort().join("\n"))
		.digest("hex");
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

function git(cwd: string, args: readonly string[]): string | undefined {
	try {
		return execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			timeout: GIT_WALL_MS,
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch {
		// Not a repository, git missing, or out of time: no answer.
		return undefined;
	}
}

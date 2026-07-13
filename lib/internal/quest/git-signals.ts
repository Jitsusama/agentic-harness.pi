/**
 * Production git predicates for the write classifier. Each shells
 * out to git from the directory enclosing the target, so a target
 * in a different repository than the session cwd is judged against
 * its own repository. Every call fails closed to the safe answer
 * when git is absent, the path is outside a repository, or the
 * subprocess errors: no tree root, not ignored, not tracked.
 *
 * The pure classifier takes these as injected predicates; this
 * module is the real implementation it composes in production.
 */

import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import * as path from "node:path";

/**
 * Wall-clock ceiling for a single git invocation. The classifier
 * runs on the synchronous tool_call path, so a wedged git must not
 * hang the event loop with no operator lever; a timeout throws,
 * which every caller already treats as the safe answer.
 */
const GIT_TIMEOUT_MS = 5000;

/** Run git in `cwd`, returning trimmed stdout, or null on any failure. */
function git(cwd: string, args: string[]): string | null {
	try {
		return execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: GIT_TIMEOUT_MS,
		}).trim();
	} catch {
		// git missing, non-zero exit (e.g. not a repo, not ignored,
		// not tracked) or any spawn error: the caller's safe answer.
		return null;
	}
}

/**
 * The canonical directory to run git from and the canonical target
 * path, for a target that may not exist yet. Walks up to the
 * nearest existing ancestor (so git runs from a real directory
 * even when several leading path segments are missing) and
 * realpath's it, so a /var versus /private/var spelling does not
 * read as outside the repository. The missing tail is re-appended
 * to form the full canonical target.
 */
function located(absPath: string): { dir: string; target: string } {
	const resolved = path.resolve(absPath);
	const tail: string[] = [];
	let prefix = path.dirname(resolved);
	tail.unshift(path.basename(resolved));
	while (true) {
		try {
			const dir = realpathSync(prefix);
			return { dir, target: path.join(dir, ...tail) };
		} catch {
			// prefix does not exist; step up and try its parent.
		}
		const parent = path.dirname(prefix);
		if (parent === prefix) return { dir: prefix, target: resolved };
		tail.unshift(path.basename(prefix));
		prefix = parent;
	}
}

/**
 * The git working tree root containing the target, or null when the
 * target is not inside any repository. Resolves through `.git` files
 * (worktrees) natively via rev-parse.
 */
export function gitTreeRootOf(absPath: string): string | null {
	const root = git(located(absPath).dir, ["rev-parse", "--show-toplevel"]);
	return root && root.length > 0 ? root : null;
}

/**
 * Whether the target sits in a repository's primary checkout, as
 * opposed to a linked worktree. The main tree's git-dir equals its
 * git-common-dir; a linked worktree's git-dir is under
 * `.git/worktrees/`, so the two differ. False when git cannot answer
 * or the path is outside any repository, so a doubtful case never
 * reads as the shared main tree by accident.
 */
export function isMainWorkingTree(absPath: string): boolean {
	// Probe a child path so git runs from the directory itself, the
	// same trick gitTreeRootOf uses; located() otherwise resolves to
	// the parent of an existing directory.
	const { dir } = located(path.join(absPath, ".quest-tree-probe"));
	const gitDir = git(dir, ["rev-parse", "--path-format=absolute", "--git-dir"]);
	const commonDir = git(dir, [
		"rev-parse",
		"--path-format=absolute",
		"--git-common-dir",
	]);
	if (!gitDir || !commonDir) return false;
	return canonicalPath(gitDir) === canonicalPath(commonDir);
}

/** Whether the target is gitignored at its destination. */
export function isGitignored(absPath: string): boolean {
	const { dir, target } = located(absPath);
	try {
		execFileSync("git", ["check-ignore", "-q", "--", target], {
			cwd: dir,
			stdio: "ignore",
			timeout: GIT_TIMEOUT_MS,
		});
		return true;
	} catch {
		// Exit 1 (not ignored) and 128 (not a repo) both land here as
		// "not ignored," which is the safe answer for the classifier.
		return false;
	}
}

/**
 * Canonicalize a path for comparison, tolerating a path that does
 * not exist yet. Resolves the longest existing ancestor (which
 * turns /var into /private/var on macOS) and re-appends the missing
 * tail. The literal path survives a total failure.
 */
export function canonicalPath(p: string): string {
	const tail: string[] = [];
	let prefix = p;
	while (!existsSync(prefix)) {
		const parent = path.dirname(prefix);
		if (parent === prefix) return p;
		tail.unshift(path.basename(prefix));
		prefix = parent;
	}
	try {
		const real = realpathSync(prefix);
		return tail.length > 0 ? path.join(real, ...tail) : real;
	} catch {
		// realpath can fail on a broken symlink; the literal path is best.
		return p;
	}
}

/**
 * Whether `child` is `parent` or lives beneath it, comparing
 * canonicalized paths with a separator boundary so a /var versus
 * /private/var spelling still matches and a sibling whose name
 * merely shares a prefix (feature-2 against feat) does not.
 */
export function isWithin(child: string, parent: string): boolean {
	const c = canonicalPath(child);
	const p = canonicalPath(parent);
	return c === p || c.startsWith(p + path.sep);
}

/** Whether the target is tracked in its repository's index. */
export function isTracked(absPath: string): boolean {
	const { dir, target } = located(absPath);
	try {
		execFileSync("git", ["ls-files", "--error-unmatch", "--", target], {
			cwd: dir,
			stdio: "ignore",
			timeout: GIT_TIMEOUT_MS,
		});
		return true;
	} catch {
		// Non-zero exit (untracked or not a repo): not tracked.
		return false;
	}
}

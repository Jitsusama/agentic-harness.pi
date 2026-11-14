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
 *
 * Those the write gate asks on every write answer asynchronously, and
 * ask git nothing where no `.git` sits above the target. A host runs
 * every conversation on one loop, and each git started with
 * execFileSync held all of them until it exited; even a child started
 * asynchronously is forked from that loop, so a target in no checkout,
 * as most shell redirects are, starts none.
 */

import { execFile, execFileSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import * as path from "node:path";
import { gitRules } from "../sandbox.ts";
import { gitRun } from "../tree-git.ts";

/**
 * Wall-clock ceiling for a single git invocation. A wedged git must
 * not hold a tool call, or for the synchronous lookups the loop, with
 * no operator lever; a timeout fails, which every caller already
 * treats as the safe answer.
 */
const GIT_TIMEOUT_MS = 5000;

/**
 * git's arguments for `cwd`, or null when pi may not run git there.
 * pi runs these outside any sandbox, on every write it judges, so they
 * are held to the folders whose git a sandboxed command couldn't have
 * set (`tree-git.ts`): a write into a repository one made would
 * otherwise run whatever its settings name.
 */
function allowed(cwd: string, args: string[]): string[] | null {
	const run = gitRun(cwd, args, gitRules());
	return "refused" in run ? null : [...run.args];
}

/** Run git in `cwd`, returning trimmed stdout, or null on any failure. */
function git(cwd: string, args: string[]): string | null {
	const held = allowed(cwd, args);
	if (!held) return null;
	try {
		return execFileSync("git", held, {
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
 * Run git in `cwd` off the loop: its trimmed stdout, or null on any
 * failure, as `git` gives, and null at once, with no git started, where
 * no `.git` sits at or above `cwd`, since git would find no repository
 * there either.
 */
function gitOffLoop(cwd: string, args: string[]): Promise<string | null> {
	if (!inCheckout(cwd)) return Promise.resolve(null);
	const held = allowed(cwd, args);
	if (!held) return Promise.resolve(null);
	return new Promise((resolve) => {
		execFile(
			"git",
			held,
			{ cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS },
			(error, stdout) => {
				// git missing, non-zero exit (not a repo, not ignored, not
				// tracked) or any spawn error: the caller's safe answer.
				resolve(error ? null : stdout.trim());
			},
		);
	});
}

/**
 * Whether a `.git` entry, a repo's folder or a worktree's file, sits at
 * or above `dir`.
 */
function inCheckout(dir: string): boolean {
	let at = path.resolve(dir);
	for (;;) {
		if (existsSync(path.join(at, ".git"))) return true;
		const parent = path.dirname(at);
		if (parent === at) return false;
		at = parent;
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
 *
 * Accepts a directory as readily as a file. It did not always: it ran
 * git from `located().dir`, which resolves an existing directory to
 * its parent, and the parent of a repository root is outside the
 * repository. So the one input a caller is most likely to hold, the
 * root of the checkout they are standing in, answered null. Two
 * callers knew and worked around it by appending a filename they
 * invented; the third did not, and shipped a verb that refused in the
 * only place it was meant to work.
 */
export function gitTreeRootOf(absPath: string): string | null {
	const root = git(fromInside(absPath), ["rev-parse", "--show-toplevel"]);
	return root && root.length > 0 ? root : null;
}

/**
 * The git working tree root containing the target, as `gitTreeRootOf`
 * answers it, asked off the loop: for the write gate, which asks it on
 * every write.
 */
export async function treeRootOf(absPath: string): Promise<string | null> {
	const root = await gitOffLoop(fromInside(absPath), [
		"rev-parse",
		"--show-toplevel",
	]);
	return root && root.length > 0 ? root : null;
}

/**
 * The root a tree a quest tracks is compared on: the tree itself when
 * it holds a `.git` entry, which makes it its own root, otherwise git's
 * root for it, otherwise the path as it is.
 *
 * The write gate asks this of every tracked tree on every write, on
 * pi's input path. Asking git each time ran one process per tree per
 * write: 87 for a quest tracking 87 worktrees, and 3,988 root lookups
 * in 57 minutes on one machine. A tracked tree is nearly always a
 * checkout's own top, so a stat answers it; a subdirectory somebody
 * adopted still goes to git, off the loop. A `.git` git cannot read
 * gives the path itself, which is what a failed git lookup gave too.
 */
export async function trackedTreeRoot(
	absPath: string,
	rootOf: (p: string) => Promise<string | null> = treeRootOf,
): Promise<string> {
	if (existsSync(path.join(absPath, ".git"))) return canonicalPath(absPath);
	return canonicalPath((await rootOf(absPath)) ?? absPath);
}

/**
 * The directory to run git from for a target: the target itself when
 * it is a directory, and otherwise the nearest existing ancestor.
 */
function fromInside(absPath: string): string {
	try {
		if (statSync(absPath).isDirectory()) return realpathSync(absPath);
	} catch {
		// Does not exist, so it is a path a caller invented to probe with.
		// located() walks up to the nearest real ancestor, which is what
		// those callers were relying on and what still happens below.
	}
	return located(absPath).dir;
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

/**
 * Whether a repository has no commits yet, which only one just made
 * with `git init` has: nobody else can share a checkout that new.
 */
export function hasNoCommits(absPath: string): boolean {
	const { dir } = located(path.join(absPath, ".quest-tree-probe"));
	if (!git(dir, ["rev-parse", "--git-dir"])) return false;
	return git(dir, ["rev-parse", "--verify", "-q", "HEAD"]) === null;
}

/**
 * Whether the target is gitignored at its destination. Exit 1 (not
 * ignored) and 128 (not a repo) both read as not ignored, which is the
 * safe answer for the classifier.
 */
export async function isGitignored(absPath: string): Promise<boolean> {
	const { dir, target } = located(absPath);
	const answer = await gitOffLoop(dir, ["check-ignore", "-q", "--", target]);
	return answer !== null;
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

/**
 * Whether the target is tracked in its repository's index. A non-zero
 * exit (untracked, or not a repo) reads as not tracked.
 */
export async function isTracked(absPath: string): Promise<boolean> {
	const { dir, target } = located(absPath);
	const answer = await gitOffLoop(dir, [
		"ls-files",
		"--error-unmatch",
		"--",
		target,
	]);
	return answer !== null;
}

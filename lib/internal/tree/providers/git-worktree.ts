/**
 * Built-in git-worktree provider.
 *
 * Creates trees at `<repo>/.worktrees/<name>/` and ensures
 * `.worktrees/` is gitignored in the host repo on first
 * use. Prune refuses dirty working trees and unmerged
 * branches unless `force: true`; the quest workflow's
 * higher-level safety gate forwards the user's resolution
 * answer through the `force` flag.
 *
 * Default branch detection uses `git symbolic-ref` on
 * `refs/remotes/origin/HEAD`, falling back to `main` then
 * `master`. The `appliesTo` check is universal: this
 * provider returns true for any directory inside a git
 * working tree, so downstream packages register at lower
 * priority to take over for specific repos.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type {
	CreateTreeInput,
	PruneTreeInput,
	TreeHandle,
	TreeProvider,
} from "../../../tree/types.js";

const execFileAsync = promisify(execFile);

const PROVIDER_ID = "git-worktree";
const DEFAULT_PRIORITY = 100;
const WORKTREES_DIR = ".worktrees";

/**
 * Run a git command in a directory and return stdout
 * trimmed. Throws on non-zero exit.
 */
async function git(cwd: string, ...args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("git", args, { cwd });
	return stdout.toString().trim();
}

/**
 * Try a git command; return undefined on failure rather
 * than throwing. Used for probes where "not a git repo"
 * is a legitimate answer.
 */
async function tryGit(
	cwd: string,
	...args: string[]
): Promise<string | undefined> {
	try {
		return await git(cwd, ...args);
	} catch {
		// Probe failed; caller treats this as "no answer".
		return undefined;
	}
}

/** Determine the repo's default branch. */
async function detectDefaultBranch(repoRoot: string): Promise<string> {
	const headRef = await tryGit(
		repoRoot,
		"symbolic-ref",
		"refs/remotes/origin/HEAD",
	);
	if (headRef?.startsWith("refs/remotes/origin/")) {
		return headRef.slice("refs/remotes/origin/".length);
	}
	const main = await tryGit(repoRoot, "rev-parse", "--verify", "main");
	if (main) return "main";
	const master = await tryGit(repoRoot, "rev-parse", "--verify", "master");
	if (master) return "master";
	// As a last resort, return HEAD's current branch.
	const current = await tryGit(repoRoot, "rev-parse", "--abbrev-ref", "HEAD");
	return current ?? "main";
}

/**
 * Make sure `.worktrees/` is gitignored at the repo root so
 * the worktree directories don't show up as untracked
 * files. Idempotent.
 */
function ensureGitignore(repoRoot: string): void {
	const path = join(repoRoot, ".gitignore");
	const entry = `${WORKTREES_DIR}/`;
	const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
	const lines = existing.split("\n");
	if (lines.some((line) => line.trim() === entry)) return;
	const next =
		existing.length === 0 || existing.endsWith("\n")
			? `${existing}${entry}\n`
			: `${existing}\n${entry}\n`;
	writeFileSync(path, next, "utf8");
}

/**
 * `git status --porcelain` produces one line per dirty
 * file. Empty stdout means the tree is clean.
 */
async function isDirty(treePath: string): Promise<boolean> {
	const status = await tryGit(treePath, "status", "--porcelain");
	return Boolean(status && status.length > 0);
}

/**
 * Return true when `branch` contains commits that
 * `origin/<defaultBranch>` does not.
 */
async function hasUnmergedCommits(
	repoRoot: string,
	branch: string,
): Promise<boolean> {
	const defaultBranch = await detectDefaultBranch(repoRoot);
	const ahead = await tryGit(
		repoRoot,
		"rev-list",
		"--count",
		`origin/${defaultBranch}..${branch}`,
	);
	if (ahead === undefined) return false;
	return Number.parseInt(ahead, 10) > 0;
}

/** Build the provider. */
export function createGitWorktreeProvider(
	priority = DEFAULT_PRIORITY,
): TreeProvider {
	return {
		id: PROVIDER_ID,
		priority,
		appliesTo(repoRoot: string): boolean {
			// Cheap structural probe: `.git` exists either
			// as a directory (normal clone) or a file
			// (worktree). Symbolic-ref probes the real
			// repository.
			return existsSync(join(repoRoot, ".git"));
		},
		async create(input: CreateTreeInput): Promise<TreeHandle> {
			const repoRoot = resolve(input.repoRoot);
			const treePath = join(repoRoot, WORKTREES_DIR, input.name);
			if (existsSync(treePath)) {
				throw new Error(
					`A tree already exists at ${treePath}. Pick a different name or prune the existing one first.`,
				);
			}
			ensureGitignore(repoRoot);
			const base = input.baseBranch ?? (await detectDefaultBranch(repoRoot));
			await git(repoRoot, "worktree", "add", treePath, "-b", input.name, base);
			return {
				path: treePath,
				branch: input.name,
				repoRoot,
				providerId: PROVIDER_ID,
			};
		},
		async prune(input: PruneTreeInput): Promise<void> {
			const treePath = resolve(input.path);
			if (!existsSync(treePath)) {
				// Tree directory is gone but git's admin entry
				// may still be around. Walk up looking for the
				// containing repo so we can run
				// `git worktree prune` against it. When we
				// can't find it, treat the prune as already
				// done.
				let ancestor = dirname(treePath);
				while (ancestor !== dirname(ancestor)) {
					if (existsSync(join(ancestor, ".git"))) {
						await tryGit(ancestor, "worktree", "prune");
						return;
					}
					ancestor = dirname(ancestor);
				}
				return;
			}
			// `--show-toplevel` from inside a worktree returns
			// the worktree path itself, not the main repo.
			// `--git-common-dir` always points at the shared
			// `.git`; the main repo is its parent.
			const commonDir = await git(treePath, "rev-parse", "--git-common-dir");
			const absoluteCommonDir = resolve(treePath, commonDir);
			const repoRoot = dirname(absoluteCommonDir);
			const branch =
				(await tryGit(treePath, "rev-parse", "--abbrev-ref", "HEAD")) ?? "";
			if (!input.force) {
				if (await isDirty(treePath)) {
					throw new Error(
						`Tree at ${treePath} has uncommitted changes. Commit, stash or force-prune.`,
					);
				}
				if (branch && (await hasUnmergedCommits(repoRoot, branch))) {
					throw new Error(
						`Branch ${branch} has commits not in origin's default branch. Push and merge first, or force-prune.`,
					);
				}
			}
			await git(
				repoRoot,
				"worktree",
				"remove",
				treePath,
				...(input.force ? ["--force"] : []),
			);
			if (branch) {
				// Delete the branch when it's fully merged
				// or the user forced. Failures here are
				// non-fatal: the worktree itself is gone.
				const deleteFlag = input.force ? "-D" : "-d";
				await tryGit(repoRoot, "branch", deleteFlag, branch);
			}
		},
		async list(repoRoot: string): Promise<TreeHandle[]> {
			const root = resolve(repoRoot);
			const stdout = await tryGit(root, "worktree", "list", "--porcelain");
			if (!stdout) return [];
			const handles: TreeHandle[] = [];
			let current: Partial<TreeHandle> = {};
			for (const line of stdout.split("\n")) {
				if (line.startsWith("worktree ")) {
					if (current.path) {
						handles.push({
							path: current.path,
							branch: current.branch,
							repoRoot: root,
							providerId: PROVIDER_ID,
						});
					}
					current = { path: line.slice("worktree ".length) };
				} else if (line.startsWith("branch ")) {
					const ref = line.slice("branch ".length);
					current.branch = ref.replace(/^refs\/heads\//, "");
				} else if (line === "") {
					if (current.path) {
						handles.push({
							path: current.path,
							branch: current.branch,
							repoRoot: root,
							providerId: PROVIDER_ID,
						});
						current = {};
					}
				}
			}
			if (current.path) {
				handles.push({
					path: current.path,
					branch: current.branch,
					repoRoot: root,
					providerId: PROVIDER_ID,
				});
			}
			// The first entry is always the main worktree;
			// drop it so callers see only the
			// `.worktrees/<name>` siblings.
			return handles.slice(1);
		},
	};
}

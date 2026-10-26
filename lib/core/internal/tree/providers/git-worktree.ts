/**
 * Built-in git-worktree provider.
 *
 * Creates trees at `<repo>/.worktrees/<name>/` and ensures
 * `.worktrees/` is gitignored in the host repo on first
 * use. Prune refuses dirty working trees and unmerged
 * branches unless `force: true`; a higher-level safety gate
 * forwards the caller's resolution answer through the
 * `force` flag.
 *
 * Default branch detection uses `git symbolic-ref` on
 * `refs/remotes/origin/HEAD`, falling back to `main` then
 * `master`. The `appliesTo` check is universal: this
 * provider returns true for any directory inside a git
 * working tree, so downstream packages register at lower
 * priority to take over for specific repos.
 *
 * Every operation runs its git unattended, under one clock for the
 * whole operation and the caller's signal. `git worktree add` runs
 * the repo's checkout hooks, and a hook waiting on the network held
 * `tree-add` with nothing anybody could press.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { abortError, WallClockExceeded } from "../../../../clock/bound.ts";
import { spawnExec } from "../../../exec/spawn.ts";
import type {
	CreateTreeInput,
	ReleaseTreeInput,
	TreeHandle,
	TreeProvider,
} from "../../../tree/types.ts";

const PROVIDER_ID = "git-worktree";
const DEFAULT_PRIORITY = 100;
const WORKTREES_DIR = ".worktrees";

/**
 * How long one operation may take, all of its git together. Generous,
 * since a first checkout of a large repo is slow, but finite.
 */
export const TREE_WALL_MS = 10 * 60 * 1000;

/**
 * How long tidying up after a stopped cut may take. Short, because the
 * caller has already given up and is waiting only for this.
 */
const TIDY_WALL_MS = 10_000;

/**
 * How long refreshing the default branch before a release may take. Short
 * and best effort: offline, the release judges against what it last saw.
 */
const FETCH_WALL_MS = 15_000;

/** How the provider is bounded. */
export interface GitWorktreeOptions {
	/** The longest one operation may run. `TREE_WALL_MS` when absent. */
	wallMs?: number;
}

/**
 * One operation's bounds: the caller's signal and a clock, folded into
 * the one signal every git call in the operation runs under, with the
 * reason it fired kept so the caller hears which of the two it was.
 */
interface Operation {
	readonly signal: AbortSignal;
	/** Why the operation was stopped, or undefined while it may run. */
	stopped(): Error | undefined;
	/** Let go of the clock and the caller's signal. */
	end(): void;
}

function operation(
	what: string,
	wallMs: number,
	caller?: AbortSignal,
): Operation {
	const controller = new AbortController();
	let why: Error | undefined;
	const stop = (reason: Error): void => {
		why ??= reason;
		controller.abort(why);
	};
	const onAbort = (): void => stop(abortError(caller));
	if (caller?.aborted) onAbort();
	else caller?.addEventListener("abort", onAbort, { once: true });
	const clock = setTimeout(
		() => stop(new WallClockExceeded(what, wallMs)),
		wallMs,
	);
	return {
		signal: controller.signal,
		stopped: () => why,
		end() {
			clearTimeout(clock);
			caller?.removeEventListener("abort", onAbort);
		},
	};
}

/** Throw the reason an operation was stopped, if it was. */
function assertRunning(op: Operation): void {
	const why = op.stopped();
	if (why) throw why;
}

/**
 * Slug pattern for tree names and base branches that
 * flow into a path join and a git argv. Restrictive on
 * purpose: alphanumeric plus dot, slash, underscore and
 * dash, must not start with a dot or dash, and rejects
 * `..` segments anywhere.
 */
const NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/;

function assertValidName(label: string, value: string): void {
	if (!value) {
		throw new Error(`${label} cannot be empty.`);
	}
	if (!NAME_PATTERN.test(value)) {
		throw new Error(
			`${label} must match ${NAME_PATTERN.source}; got ${JSON.stringify(value)}.`,
		);
	}
	if (value.split("/").some((part) => part === "" || part === "..")) {
		throw new Error(
			`${label} cannot contain empty or '..' path segments; got ${JSON.stringify(value)}.`,
		);
	}
}

/**
 * Run a git command in a directory and return stdout
 * trimmed. Throws on non-zero exit, and throws the
 * operation's reason when it was stopped.
 */
async function git(
	op: Operation,
	cwd: string,
	...args: string[]
): Promise<string> {
	const result = await spawnExec({ signal: op.signal, cwd })("git", args);
	if (result.code !== 0) {
		throw (
			op.stopped() ??
			new Error(
				`Command failed: git ${args.join(" ")}\n${result.stderr.trim()}`,
			)
		);
	}
	return result.stdout.trim();
}

/**
 * Try a git command; return undefined on failure rather
 * than throwing. Used for probes where "not a git repo"
 * is a legitimate answer. Being stopped is not an answer,
 * so that still throws.
 */
async function tryGit(
	op: Operation,
	cwd: string,
	...args: string[]
): Promise<string | undefined> {
	try {
		return await git(op, cwd, ...args);
	} catch (error) {
		if (op.stopped()) throw error;
		// Probe failed; caller treats this as "no answer".
		return undefined;
	}
}

/**
 * Take back a tree whose cut was stopped part way.
 *
 * Git clears its own junk flag once the checkout is done and before
 * `post-checkout` runs, so a cut stopped in a hook leaves a finished
 * worktree and its branch behind, which the next `tree-add` under that
 * name then refuses over. The directory did not exist before this cut,
 * so it is ours to remove, and so is the branch unless it was already
 * there. Best effort under a short clock of its own: the caller's
 * signal has already fired, and nothing here runs a hook.
 */
async function tidyStoppedCut(
	repoRoot: string,
	treePath: string,
	branch: string | undefined,
): Promise<void> {
	const tidy = operation(`tidying ${treePath}`, TIDY_WALL_MS);
	try {
		// Twice forced, because a cut stopped early is still locked.
		await tryGit(tidy, repoRoot, "worktree", "remove", "-f", "-f", treePath);
		rmSync(treePath, { recursive: true, force: true });
		await tryGit(tidy, repoRoot, "worktree", "prune");
		if (branch) await tryGit(tidy, repoRoot, "branch", "-D", branch);
	} catch {
		// The tidy clock ran out. What is left is what a killed git
		// leaves, and the original stop is the error worth reporting.
	} finally {
		tidy.end();
	}
}

/** Determine the repo's default branch. */
async function detectDefaultBranch(
	op: Operation,
	repoRoot: string,
): Promise<string> {
	const headRef = await tryGit(
		op,
		repoRoot,
		"symbolic-ref",
		"refs/remotes/origin/HEAD",
	);
	if (headRef?.startsWith("refs/remotes/origin/")) {
		return headRef.slice("refs/remotes/origin/".length);
	}
	const main = await tryGit(op, repoRoot, "rev-parse", "--verify", "main");
	if (main) return "main";
	const master = await tryGit(op, repoRoot, "rev-parse", "--verify", "master");
	if (master) return "master";
	// As a last resort, return HEAD's current branch.
	const current = await tryGit(
		op,
		repoRoot,
		"rev-parse",
		"--abbrev-ref",
		"HEAD",
	);
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
async function isDirty(op: Operation, treePath: string): Promise<boolean> {
	const status = await tryGit(op, treePath, "status", "--porcelain");
	return Boolean(status && status.length > 0);
}

/**
 * Bring `origin/<branch>` up to date, so a change merged on the host
 * since the last fetch reads as merged. Only that one ref is fetched, on
 * a clock of its own; a failure leaves the comparison to the ref as it
 * was. Being stopped by the caller still throws.
 */
async function refreshRemoteBranch(
	op: Operation,
	repoRoot: string,
	branch: string,
): Promise<void> {
	const fetch = operation(
		`fetching origin/${branch}`,
		FETCH_WALL_MS,
		op.signal,
	);
	try {
		await tryGit(
			fetch,
			repoRoot,
			"fetch",
			"--quiet",
			"--no-tags",
			"--no-recurse-submodules",
			"origin",
			`+refs/heads/${branch}:refs/remotes/origin/${branch}`,
		);
	} catch (error) {
		if (op.stopped()) throw error;
		// The fetch's own clock ran out; judge against the ref as it was.
	} finally {
		fetch.end();
	}
}

/**
 * Whether merging `branch` into `target` would change nothing: its
 * content is already there. This is what a squash or rebase merge
 * leaves, where none of the branch's commits reach the target. A
 * conflict, or main having since reverted the change, reads as not.
 */
async function contentAlreadyIn(
	op: Operation,
	repoRoot: string,
	target: string,
	branch: string,
): Promise<boolean> {
	const merged = await tryGit(
		op,
		repoRoot,
		"merge-tree",
		"--write-tree",
		target,
		branch,
	);
	const targetTree = await tryGit(
		op,
		repoRoot,
		"rev-parse",
		`${target}^{tree}`,
	);
	const mergedTree = merged?.split("\n")[0]?.trim();
	return Boolean(mergedTree && targetTree && mergedTree === targetTree);
}

/** What a release learned about a branch against the default branch. */
interface MergeState {
	unmerged: boolean;
	comparedAgainst: string | undefined;
	/** Merged by content alone, so `git branch -d` would refuse it. */
	byContent?: boolean;
}

/**
 * Return true when `branch` contains commits that the
 * default branch does not.
 *
 * Tries `origin/<default>` first (the common shared-state
 * comparison), fetched first so a merge on the host counts,
 * then falls back to the local default branch when no
 * origin remote is wired. A branch whose commits are not in
 * the default branch but whose content is counts as merged,
 * since that is what a squash merge leaves. If neither
 * comparison succeeds the function returns true and lets
 * the caller surface the lack of a target: silently
 * returning false would let a force-less release destroy
 * unmerged work in a repo with no origin remote.
 */
async function hasUnmergedCommits(
	op: Operation,
	repoRoot: string,
	branch: string,
): Promise<MergeState> {
	const defaultBranch = await detectDefaultBranch(op, repoRoot);
	if (defaultBranch === branch) {
		return { unmerged: false, comparedAgainst: defaultBranch };
	}
	const hasOrigin = await tryGit(op, repoRoot, "remote", "get-url", "origin");
	if (hasOrigin !== undefined) {
		await refreshRemoteBranch(op, repoRoot, defaultBranch);
	}
	const originAhead = await tryGit(
		op,
		repoRoot,
		"rev-list",
		"--count",
		`origin/${defaultBranch}..${branch}`,
	);
	if (originAhead !== undefined) {
		const target = `origin/${defaultBranch}`;
		if (Number.parseInt(originAhead, 10) === 0) {
			return { unmerged: false, comparedAgainst: target };
		}
		const byContent = await contentAlreadyIn(op, repoRoot, target, branch);
		return {
			unmerged: !byContent,
			comparedAgainst: target,
			...(byContent ? { byContent } : {}),
		};
	}
	const localAhead = await tryGit(
		op,
		repoRoot,
		"rev-list",
		"--count",
		`${defaultBranch}..${branch}`,
	);
	if (localAhead !== undefined) {
		return {
			unmerged: Number.parseInt(localAhead, 10) > 0,
			comparedAgainst: defaultBranch,
		};
	}
	// No comparison target. Fail safe: claim unmerged so a
	// non-force release refuses with a clear message, and let
	// the caller force when they know better.
	return { unmerged: true, comparedAgainst: undefined };
}

/** Build the provider. */
export function createGitWorktreeProvider(
	priority = DEFAULT_PRIORITY,
	options: GitWorktreeOptions = {},
): TreeProvider {
	const wallMs = options.wallMs ?? TREE_WALL_MS;
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
			assertValidName("Tree name", input.name);
			if (input.baseBranch !== undefined) {
				assertValidName("Base branch", input.baseBranch);
			}
			const repoRoot = resolve(input.repoRoot);
			const treePath = join(repoRoot, WORKTREES_DIR, input.name);
			if (existsSync(treePath)) {
				throw new Error(
					`A tree already exists at ${treePath}. Pick a different name or release the existing one first.`,
				);
			}
			const op = operation(`cutting ${treePath}`, wallMs, input.signal);
			try {
				assertRunning(op);
				ensureGitignore(repoRoot);
				const base =
					input.baseBranch ?? (await detectDefaultBranch(op, repoRoot));
				// Known before the cut, so a stopped one deletes only a
				// branch it made itself.
				const branchWasThere =
					(await tryGit(
						op,
						repoRoot,
						"rev-parse",
						"--verify",
						"--quiet",
						`refs/heads/${input.name}`,
					)) !== undefined;
				try {
					// `--` separates positional args from refs so a base
					// or branch name that happens to start with a dash
					// (already refused by assertValidName) cannot be
					// reparsed as a flag by older git versions.
					await git(
						op,
						repoRoot,
						"worktree",
						"add",
						"-b",
						input.name,
						treePath,
						"--",
						base,
					);
				} catch (error) {
					// Only a stop leaves anything: a cut git itself refused
					// is one git has already cleaned up after.
					if (op.stopped()) {
						await tidyStoppedCut(
							repoRoot,
							treePath,
							branchWasThere ? undefined : input.name,
						);
					}
					throw error;
				}
			} finally {
				op.end();
			}
			return {
				path: treePath,
				branch: input.name,
				repoRoot,
				providerId: PROVIDER_ID,
			};
		},
		async release(input: ReleaseTreeInput): Promise<void> {
			const treePath = resolve(input.path);
			const op = operation(`pruning ${treePath}`, wallMs, input.signal);
			try {
				assertRunning(op);
				await releaseTree(op, treePath, input.force === true);
			} finally {
				op.end();
			}
		},
		async list(repoRoot: string): Promise<TreeHandle[]> {
			const root = resolve(repoRoot);
			const op = operation(`listing trees of ${root}`, wallMs);
			try {
				return parseWorktreeList(
					root,
					await tryGit(op, root, "worktree", "list", "--porcelain"),
				);
			} finally {
				op.end();
			}
		},
	};
}

/**
 * Remove a tree and its branch, refusing dirty or unmerged work
 * unless forced. A stop part way leaves the tree where it was
 * unless `git worktree remove` itself was the call stopped.
 */
async function releaseTree(
	op: Operation,
	treePath: string,
	force: boolean,
): Promise<void> {
	if (!existsSync(treePath)) {
		// Tree directory is gone but git's admin entry
		// may still be around. Walk up looking for the
		// containing repo so we can run
		// `git worktree prune` against it. When we
		// can't find it, treat the release as already
		// done.
		let ancestor = dirname(treePath);
		while (ancestor !== dirname(ancestor)) {
			if (existsSync(join(ancestor, ".git"))) {
				await tryGit(op, ancestor, "worktree", "prune");
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
	const commonDir = await git(op, treePath, "rev-parse", "--git-common-dir");
	const absoluteCommonDir = resolve(treePath, commonDir);
	const repoRoot = dirname(absoluteCommonDir);
	const branch =
		(await tryGit(op, treePath, "rev-parse", "--abbrev-ref", "HEAD")) ?? "";
	let mergedByContent = false;
	if (!force) {
		if (await isDirty(op, treePath)) {
			throw new Error(
				`Tree at ${treePath} has uncommitted changes. Commit them, or release it with force.`,
			);
		}
		if (branch) {
			const { unmerged, comparedAgainst, byContent } = await hasUnmergedCommits(
				op,
				repoRoot,
				branch,
			);
			mergedByContent = byContent === true;
			if (unmerged) {
				const target = comparedAgainst
					? `against ${comparedAgainst}`
					: "and no default-branch comparison target exists (no origin remote, no local main/master)";
				throw new Error(
					`Branch ${branch} has commits not merged ${target}. Push and merge first, or release it with force.`,
				);
			}
		}
	}
	await git(
		op,
		repoRoot,
		"worktree",
		"remove",
		treePath,
		...(force ? ["--force"] : []),
	);
	if (branch) {
		// Delete the branch when it's fully merged
		// or the caller forced. Failures here are
		// non-fatal: the worktree itself is gone. A
		// branch merged by content has commits `-d`
		// cannot find upstream, so it needs `-D`.
		const deleteFlag = force || mergedByContent ? "-D" : "-d";
		await tryGit(op, repoRoot, "branch", deleteFlag, branch);
	}
}

/**
 * Read `git worktree list --porcelain` into handles, leaving out
 * the main worktree so callers see only the `.worktrees/<name>`
 * siblings.
 */
function parseWorktreeList(
	root: string,
	stdout: string | undefined,
): TreeHandle[] {
	if (!stdout) return [];
	const handles: TreeHandle[] = [];
	let current: Partial<TreeHandle> = {};
	const flush = (): void => {
		if (current.path) {
			handles.push({
				path: current.path,
				branch: current.branch,
				repoRoot: root,
				providerId: PROVIDER_ID,
			});
		}
		current = {};
	};
	for (const line of stdout.split("\n")) {
		if (line.startsWith("worktree ")) {
			flush();
			current = { path: line.slice("worktree ".length) };
		} else if (line.startsWith("branch ")) {
			const ref = line.slice("branch ".length);
			current.branch = ref.replace(/^refs\/heads\//, "");
		} else if (line === "") {
			flush();
		}
	}
	flush();
	// The first entry is always the main worktree.
	return handles.slice(1);
}

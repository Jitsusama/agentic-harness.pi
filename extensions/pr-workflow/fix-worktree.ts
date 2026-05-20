/**
 * Fix worktree provisioning and cleanup.
 *
 * Council reviewers run in detached, SHA-keyed
 * worktrees: read-only and ephemeral. The fix loop
 * needs something different — a worktree with the
 * PR's branch actually checked out, so `git commit`
 * and `git push` do the obvious thing.
 *
 * Fix worktrees are keyed by PR number rather than
 * head SHA so the path stays stable as the fix loop
 * adds commits. The provisioner is idempotent: if the
 * path exists, it's left alone (the agent owns the
 * checkout's state once provisioned).
 *
 * Cleanup is exposed as a separate surface (`list` +
 * `cleanup`) because fix worktrees outlive a single
 * session by design: a fix that lands tomorrow needs
 * the same checkout it had today. Manual cleanup is
 * the v1 contract; this module gives the user a tool
 * to do it without `rm -rf` guesswork.
 *
 * The git CLI invocation is injectable as `exec`,
 * which lets unit tests assert command sequences
 * without touching a real repo.
 */

import * as path from "node:path";
import { defaultGitExec, type GitExec } from "./worktree-git.js";

/** Filesystem operations the cleanup helpers need. */
export interface FixWorktreeFs {
	readonly listDirs: (dir: string) => Promise<string[]>;
	readonly stat: (p: string) => Promise<{ readonly mtimeMs: number } | null>;
	readonly remove: (p: string) => Promise<void>;
	readonly exists: (p: string) => Promise<boolean>;
}

/** What a caller wants a fix worktree for. */
export interface FixWorktreeRequest {
	readonly owner: string;
	readonly repo: string;
	readonly number: number;
	/** PR head ref. Becomes the branch checked out. */
	readonly branch: string;
}

/** What the provisioner returns. */
export interface FixWorktreeHandle {
	/** Absolute path to the checked-out tree. */
	readonly path: string;
	/** Branch checked out in the worktree. */
	readonly branch: string;
}

/** Configuration for the provisioner. */
export interface FixWorktreeProvisionerConfig {
	/** Where fix worktrees live (XDG state-dir shaped). */
	readonly stateDir: string;
	/**
	 * Resolves a request to the absolute path of the
	 * source git repo. The provisioner runs `git fetch`
	 * and `git worktree add` against this path.
	 */
	readonly resolveSourceRepo: (request: FixWorktreeRequest) => Promise<string>;
	/** Defaults to a real git CLI runner. Override in tests. */
	readonly exec?: GitExec;
	/** Defaults to fs.access-based existence check. Override in tests. */
	readonly pathExists?: (p: string) => Promise<boolean>;
}

/** Provision (or reuse) a fix worktree for a PR. */
export type ProvisionFixWorktree = (
	request: FixWorktreeRequest,
) => Promise<FixWorktreeHandle>;

/** Deterministic on-disk path for a PR's fix worktree. */
export function fixWorktreePath(
	stateDir: string,
	request: { owner: string; repo: string; number: number },
): string {
	return path.join(
		stateDir,
		"fix-worktrees",
		`${request.owner}-${request.repo}-${request.number}`,
	);
}

/**
 * Build a fix-worktree provisioner.
 *
 * First call for a PR: `git fetch origin <branch>` then
 * `git worktree add <path> -B <branch> origin/<branch>`.
 * The `-B` form creates the branch if absent or resets
 * it if present.
 *
 * Subsequent calls: the path exists, so the provisioner
 * returns the handle without touching git. This protects
 * in-progress fix commits from being reset by a
 * re-provisioning fetch.
 */
export function createFixWorktreeProvisioner(
	config: FixWorktreeProvisionerConfig,
): ProvisionFixWorktree {
	const exec = config.exec ?? defaultGitExec;
	const pathExists = config.pathExists ?? defaultPathExists;

	return async (request) => {
		const target = fixWorktreePath(config.stateDir, request);
		const source = await config.resolveSourceRepo(request);

		if (await pathExists(target)) {
			return { path: target, branch: request.branch };
		}

		await runOrThrow(exec, ["fetch", "origin", request.branch], source);
		await runOrThrow(
			exec,
			[
				"worktree",
				"add",
				target,
				"-B",
				request.branch,
				`origin/${request.branch}`,
			],
			source,
		);

		return { path: target, branch: request.branch };
	};
}

async function defaultPathExists(p: string): Promise<boolean> {
	try {
		const fs = await import("node:fs/promises");
		await fs.access(p);
		return true;
	} catch {
		// Path doesn't exist or isn't accessible: treat as
		// absent. fs.access throws on either case and we
		// don't care to distinguish them here.
		return false;
	}
}

async function runOrThrow(
	exec: GitExec,
	args: string[],
	cwd: string,
): Promise<void> {
	const result = await exec(args, cwd);
	if (result.exitCode !== 0) {
		throw new Error(
			`git ${args.join(" ")} failed in ${cwd}: ${result.stderr.trim()}`,
		);
	}
}

/** Default fs adapter backed by node:fs/promises. */
export const defaultFixWorktreeFs: FixWorktreeFs = {
	async listDirs(dir) {
		const fs = await import("node:fs/promises");
		try {
			const entries = await fs.readdir(dir, { withFileTypes: true });
			return entries.filter((e) => e.isDirectory()).map((e) => e.name);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
	},
	async stat(p) {
		const fs = await import("node:fs/promises");
		try {
			const s = await fs.stat(p);
			return { mtimeMs: s.mtimeMs };
		} catch {
			// Missing path returns null so callers don't have
			// to branch on the error code themselves.
			return null;
		}
	},
	async remove(p) {
		const fs = await import("node:fs/promises");
		await fs.rm(p, { recursive: true, force: true });
	},
	async exists(p) {
		return defaultPathExists(p);
	},
};

/** One entry in the fix-worktree inventory. */
export interface FixWorktreeEntry {
	/** Directory name under fix-worktrees/. */
	readonly slug: string;
	/** Absolute path to the worktree. */
	readonly path: string;
	readonly owner: string;
	readonly repo: string;
	readonly number: number;
	/** Last-modified time in ms since epoch, null when unknown. */
	readonly mtimeMs: number | null;
}

/**
 * Parse a fix-worktree slug back to (owner, repo,
 * number). Returns null when the slug doesn't match
 * the `<owner>-<repo>-<number>` shape this module
 * writes — unknown directories are preserved verbatim
 * in the slug so the user can still target them.
 */
function parseSlug(
	slug: string,
): { owner: string; repo: string; number: number } | null {
	// Strip from the trailing -<digits> first; the
	// remaining slug splits owner / repo on the first
	// hyphen. owners and repos can contain hyphens; we
	// pick the leftmost hyphen as the boundary so that
	// dashes in repo names stay attached to the repo
	// (more common than dashes in owner handles).
	const numberMatch = slug.match(/-(\d+)$/);
	if (!numberMatch) return null;
	const number = Number.parseInt(numberMatch[1] ?? "", 10);
	if (!Number.isFinite(number)) return null;
	const remainder = slug.slice(0, slug.length - numberMatch[0].length);
	const boundary = remainder.indexOf("-");
	if (boundary < 0) return null;
	const owner = remainder.slice(0, boundary);
	const repo = remainder.slice(boundary + 1);
	if (!owner || !repo) return null;
	return { owner, repo, number };
}

/**
 * Enumerate every PR-keyed fix worktree currently on
 * disk. Returns an empty list when the fix-worktrees
 * directory doesn't exist (no fix loop has ever run
 * in this state dir) or when no entries match the
 * expected slug shape.
 *
 * Entries are sorted oldest-first so the user can
 * see what's been lying around longest.
 */
export async function listFixWorktrees(
	stateDir: string,
	fs: FixWorktreeFs = defaultFixWorktreeFs,
): Promise<FixWorktreeEntry[]> {
	const root = path.join(stateDir, "fix-worktrees");
	const slugs = await fs.listDirs(root);
	const entries: FixWorktreeEntry[] = [];
	for (const slug of slugs) {
		const parsed = parseSlug(slug);
		if (parsed === null) continue;
		const dir = path.join(root, slug);
		const statResult = await fs.stat(dir);
		entries.push({
			slug,
			path: dir,
			owner: parsed.owner,
			repo: parsed.repo,
			number: parsed.number,
			mtimeMs: statResult?.mtimeMs ?? null,
		});
	}
	entries.sort((a, b) => {
		const left = a.mtimeMs ?? Number.POSITIVE_INFINITY;
		const right = b.mtimeMs ?? Number.POSITIVE_INFINITY;
		return left - right;
	});
	return entries;
}

/** What a caller wants cleaned up. */
export interface CleanupFixWorktreeRequest {
	readonly stateDir: string;
	readonly owner: string;
	readonly repo: string;
	readonly number: number;
	/**
	 * When true, fall back to `rm -rf` after
	 * `git worktree remove` fails. Use when the worktree
	 * has uncommitted edits the user explicitly wants to
	 * abandon. Defaults to false.
	 */
	readonly force?: boolean;
}

/** Outcome of a cleanup attempt. */
export type CleanupFixWorktreeOutcome =
	| {
			readonly status: "removed";
			readonly path: string;
			readonly method: "git" | "force";
	  }
	| { readonly status: "missing"; readonly path: string }
	| {
			readonly status: "blocked";
			readonly path: string;
			readonly reason: string;
			readonly hint: string;
	  };

/**
 * Remove a fix worktree.
 *
 * Tries `git worktree remove <path>` first — the
 * polite path that errors out when the worktree has
 * unsaved edits or untracked files. When that fails
 * and `force` is true, falls back to `rm -rf`
 * (callers carry the responsibility for asking the
 * user).
 *
 * Returns a structured outcome rather than throwing
 * so the calling action can render a useful message
 * in either branch.
 */
export async function cleanupFixWorktree(
	request: CleanupFixWorktreeRequest,
	exec: GitExec = defaultGitExec,
	fs: FixWorktreeFs = defaultFixWorktreeFs,
): Promise<CleanupFixWorktreeOutcome> {
	const target = fixWorktreePath(request.stateDir, request);
	if (!(await fs.exists(target))) {
		return { status: "missing", path: target };
	}

	const result = await exec(["worktree", "remove", target], target);
	if (result.exitCode === 0) {
		return { status: "removed", path: target, method: "git" };
	}

	if (!request.force) {
		return {
			status: "blocked",
			path: target,
			reason: result.stderr.trim() || "git worktree remove refused",
			hint: "Re-run with force:true to delete uncommitted work and stale admin state.",
		};
	}

	await fs.remove(target);
	return { status: "removed", path: target, method: "force" };
}

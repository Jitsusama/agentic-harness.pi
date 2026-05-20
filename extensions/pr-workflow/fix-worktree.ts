/**
 * Fix worktree provisioning.
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
 * The git CLI invocation is injectable as `exec`,
 * which lets unit tests assert command sequences
 * without touching a real repo.
 */

import * as path from "node:path";
import { defaultGitExec, type GitExec } from "./worktree-git.js";

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
	request: FixWorktreeRequest,
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

/**
 * Native git implementation of `WorktreeProvider`.
 *
 * Shells out to `git worktree add --detach` and
 * `git worktree remove --force` against a user-resolved
 * source clone. The source path is supplied by a
 * `resolveSourceRepo` callback — the provider stays out
 * of clone-discovery business so different setups (user
 * clones in `~/src/...`, bare clones in state dir,
 * monorepo zones) can each plug in their own resolver.
 *
 * The git CLI invocation is injectable as `exec`, which
 * lets unit tests assert command sequences without
 * touching a real repo. An integration-style test against
 * a real temp git directory is welcome as a follow-up
 * but isn't required for the contract this module ships.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
	WorktreeHandle,
	WorktreeProvider,
	WorktreeRequest,
} from "./worktree.js";

/** Result of one git CLI invocation. */
export interface GitExecResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
}

/** Injectable git CLI runner. */
export type GitExec = (args: string[], cwd?: string) => Promise<GitExecResult>;

/** Configuration for the git provider. */
export interface GitWorktreeProviderConfig {
	/** Where worktrees live (XDG state-dir shaped). */
	readonly stateDir: string;
	/**
	 * Resolves a request to the absolute path of the
	 * source git repo that hosts the desired SHA. The
	 * provider runs `git worktree add` against this path.
	 */
	readonly resolveSourceRepo: (request: WorktreeRequest) => Promise<string>;
	/** Defaults to a real git CLI runner. Override in tests. */
	readonly exec?: GitExec;
	/** Defaults to fs.access-based existence check. Override in tests. */
	readonly pathExists?: (p: string) => Promise<boolean>;
}

const PROVIDER_ID = "git";

/** Create a native-git `WorktreeProvider`. */
export function createGitWorktreeProvider(
	config: GitWorktreeProviderConfig,
): WorktreeProvider {
	const exec = config.exec ?? defaultExec;
	const pathExists = config.pathExists ?? defaultPathExists;

	return {
		id: PROVIDER_ID,

		async ensure(request) {
			const sourceRepo = await config.resolveSourceRepo(request);
			const target = worktreePath(config.stateDir, request);

			if (await pathExists(target)) {
				const head = await exec(["rev-parse", "HEAD"], target);
				if (head.exitCode === 0 && head.stdout.trim() === request.sha) {
					return makeHandle(target, request, sourceRepo);
				}
				// Stale tree at this path: tear it down and re-create.
				await runOrThrow(
					exec,
					["worktree", "remove", "--force", target],
					sourceRepo,
				);
			}

			await runOrThrow(
				exec,
				["worktree", "add", "--detach", target, request.sha],
				sourceRepo,
			);

			return makeHandle(target, request, sourceRepo);
		},

		async release(handle) {
			const sourceRepo = handle.marker;
			if (!sourceRepo) {
				throw new Error(
					`Worktree handle is missing its source repo marker: ${handle.path}`,
				);
			}
			await runOrThrow(
				exec,
				["worktree", "remove", "--force", handle.path],
				sourceRepo,
			);
			await runOrThrow(exec, ["worktree", "prune"], sourceRepo);
		},
	};
}

function worktreePath(stateDir: string, request: WorktreeRequest): string {
	const slug = `${request.owner}-${request.repo}`;
	return path.join(stateDir, "worktrees", slug, request.sha);
}

function makeHandle(
	target: string,
	request: WorktreeRequest,
	sourceRepo: string,
): WorktreeHandle {
	return {
		path: target,
		sha: request.sha,
		branch: request.branch,
		providerId: PROVIDER_ID,
		reusable: true,
		createdAt: new Date(),
		marker: sourceRepo,
	};
}

async function runOrThrow(
	exec: GitExec,
	args: string[],
	cwd: string,
): Promise<GitExecResult> {
	const result = await exec(args, cwd);
	if (result.exitCode !== 0) {
		const cmd = `git ${args.join(" ")}`;
		const detail = result.stderr.trim() || result.stdout.trim();
		throw new Error(
			`${cmd} failed (exit ${result.exitCode})${detail ? `: ${detail}` : ""}`,
		);
	}
	return result;
}

async function defaultPathExists(p: string): Promise<boolean> {
	try {
		await fs.access(p);
		return true;
	} catch {
		// Treat any access error as "does not exist". The
		// next git call will surface a real failure mode
		// (e.g. permission denied on add) with full context.
		return false;
	}
}

const defaultExec: GitExec = (args, cwd) =>
	new Promise((resolve) => {
		execFile(
			"git",
			args,
			{ cwd, encoding: "utf8" },
			(error, stdout, stderr) => {
				if (error && typeof error.code === "number") {
					resolve({
						stdout: String(stdout ?? ""),
						stderr: String(stderr ?? ""),
						exitCode: error.code,
					});
					return;
				}
				if (error) {
					resolve({
						stdout: String(stdout ?? ""),
						stderr: String(stderr ?? error.message),
						exitCode: 1,
					});
					return;
				}
				resolve({
					stdout: String(stdout ?? ""),
					stderr: String(stderr ?? ""),
					exitCode: 0,
				});
			},
		);
	});

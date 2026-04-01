/**
 * Git worktree management for plan mode: creates isolated
 * worktrees so each plan's implementation happens in its own
 * working tree, preventing collisions with other sessions.
 *
 * Branch naming is not this module's concern. Worktrees are
 * created at HEAD with a generated name. The agent follows the
 * git-branch-convention skill to create proper branches when
 * implementation starts.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/** Directory where plan worktrees are created. */
const WORKTREE_DIR = ".worktrees";

/** Prefix for plan worktree directories. */
const PLAN_PREFIX = "plan-";

/** A single plan worktree tied to a specific repository. */
export interface PlanWorktree {
	/** Absolute path to the repository root. */
	repoPath: string;
	/** Absolute path to the worktree directory. */
	worktreePath: string;
}

/**
 * Generate a compact timestamp-based plan ID. All worktrees
 * for the same plan share this ID so they're identifiable
 * as a group.
 */
export function generatePlanId(): string {
	const now = new Date();
	const pad = (n: number, w = 2) => String(n).padStart(w, "0");
	return [
		now.getFullYear(),
		pad(now.getMonth() + 1),
		pad(now.getDate()),
		"-",
		pad(now.getHours()),
		pad(now.getMinutes()),
		pad(now.getSeconds()),
	].join("");
}

/**
 * Resolve a repo path to its git root. Accepts absolute paths
 * or "." for the current repo. Returns the absolute repo root,
 * or null if the path isn't a git repository.
 */
export async function resolveRepoRoot(
	pi: ExtensionAPI,
	repoPath: string,
): Promise<string | null> {
	const args =
		repoPath === "."
			? ["rev-parse", "--show-toplevel"]
			: ["-C", repoPath, "rev-parse", "--show-toplevel"];

	const result = await pi.exec("git", args);
	if (result.code !== 0) return null;
	return result.stdout.trim();
}

/**
 * Create a worktree for a plan in the given repository.
 * The worktree is created at the repo's HEAD with a
 * generated directory name based on the plan ID.
 *
 * Returns the worktree info, or null on failure. If a
 * worktree with the same name already exists, returns
 * its path without modifying it.
 */
export async function createPlanWorktree(
	pi: ExtensionAPI,
	repoRoot: string,
	planId: string,
): Promise<PlanWorktree | null> {
	const dirName = `${PLAN_PREFIX}${planId}`;
	const relPath = `${WORKTREE_DIR}/${dirName}`;

	// Check if the worktree already exists.
	const existing = await findWorktreePath(pi, repoRoot, dirName);
	if (existing) {
		return { repoPath: repoRoot, worktreePath: existing };
	}

	// Create the worktree at HEAD. Git auto-creates a branch
	// named after the directory; the agent renames it later
	// following the git-branch-convention skill.
	const add = await pi.exec("git", [
		"-C",
		repoRoot,
		"worktree",
		"add",
		relPath,
	]);
	if (add.code !== 0) return null;

	const absPath =
		(await findWorktreePath(pi, repoRoot, dirName)) ?? `${repoRoot}/${relPath}`;

	return { repoPath: repoRoot, worktreePath: absPath };
}

/** Remove a plan worktree by its absolute path. */
export async function removePlanWorktree(
	pi: ExtensionAPI,
	repoRoot: string,
	worktreePath: string,
): Promise<void> {
	await pi.exec("git", [
		"-C",
		repoRoot,
		"worktree",
		"remove",
		worktreePath,
		"--force",
	]);
}

/**
 * Find the absolute path of a worktree by its directory name
 * within a specific repository.
 */
async function findWorktreePath(
	pi: ExtensionAPI,
	repoRoot: string,
	dirName: string,
): Promise<string | null> {
	const list = await pi.exec("git", [
		"-C",
		repoRoot,
		"worktree",
		"list",
		"--porcelain",
	]);
	if (list.code !== 0) return null;

	for (const line of list.stdout.split("\n")) {
		if (line.startsWith("worktree ") && line.includes(dirName)) {
			return line.replace("worktree ", "");
		}
	}

	return null;
}

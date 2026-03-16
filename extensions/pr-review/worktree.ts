/**
 * Git worktree management for PR review.
 *
 * Creates an isolated worktree for reviewing PRs when we're not
 * already on the PR branch. Handles creation, path resolution,
 * and cleanup.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/** Directory where review worktrees are created. */
const WORKTREE_DIR = ".review";

/**
 * Check if the current branch matches the PR's head branch.
 * Returns the current branch name if it matches, null otherwise.
 */
export async function isOnPRBranch(
	pi: ExtensionAPI,
	prBranch: string,
): Promise<boolean> {
	const result = await pi.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
	if (result.code !== 0) return false;
	return result.stdout.trim() === prBranch;
}

/**
 * Create a worktree for reviewing a PR.
 * Fetches the PR's head ref and creates a worktree at
 * `.review/pr-<number>`.
 */
export async function createWorktree(
	pi: ExtensionAPI,
	prNumber: number,
): Promise<string> {
	const branchName = `pr-${prNumber}`;
	const worktreePath = `${WORKTREE_DIR}/${branchName}`;

	// Fetch the PR's head ref
	const fetch = await pi.exec("git", [
		"fetch",
		"origin",
		`pull/${prNumber}/head:${branchName}`,
	]);
	if (fetch.code !== 0) {
		throw new Error(`Failed to fetch PR #${prNumber}: ${fetch.stderr}`);
	}

	// Create the worktree
	const add = await pi.exec("git", [
		"worktree",
		"add",
		worktreePath,
		branchName,
	]);
	if (add.code !== 0) {
		throw new Error(`Failed to create worktree: ${add.stderr}`);
	}

	return worktreePath;
}

/**
 * Remove a review worktree and its tracking branch.
 */
export async function removeWorktree(
	pi: ExtensionAPI,
	prNumber: number,
): Promise<void> {
	const branchName = `pr-${prNumber}`;
	const worktreePath = `${WORKTREE_DIR}/${branchName}`;

	await pi.exec("git", ["worktree", "remove", worktreePath, "--force"]);
	await pi.exec("git", ["branch", "-D", branchName]);
}

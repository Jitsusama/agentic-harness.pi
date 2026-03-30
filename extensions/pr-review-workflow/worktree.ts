/**
 * Git worktree management for PR review: creates temporary
 * worktrees so reviews can read the PR's source files without
 * switching the user's working branch.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/** Directory where review worktrees are created. */
const WORKTREE_DIR = ".worktree";

/** Check if the current branch matches the PR's head branch. */
export async function isOnPRBranch(
	pi: ExtensionAPI,
	prBranch: string,
): Promise<boolean> {
	const result = await pi.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
	if (result.code !== 0) return false;
	return result.stdout.trim() === prBranch;
}

/**
 * Create a worktree for the PR branch. Fetches the PR head ref
 * and creates a worktree at `.worktree/pr-review-<number>`.
 * Returns the absolute worktree path, or null on failure.
 */
export async function createWorktree(
	pi: ExtensionAPI,
	prNumber: number,
): Promise<string | null> {
	const branchName = `pr-review-${prNumber}`;
	const relPath = `${WORKTREE_DIR}/${branchName}`;

	const fetch = await pi.exec("git", [
		"fetch",
		"origin",
		`pull/${prNumber}/head:${branchName}`,
	]);
	if (fetch.code !== 0) return null;

	const add = await pi.exec("git", ["worktree", "add", relPath, branchName]);
	if (add.code !== 0) return null;

	// We return an absolute path so fs.readFileSync works from any cwd.
	const abs = await pi.exec("git", ["worktree", "list", "--porcelain"]);
	if (abs.code === 0) {
		for (const line of abs.stdout.split("\n")) {
			if (line.startsWith("worktree ") && line.includes(branchName)) {
				return line.replace("worktree ", "");
			}
		}
	}

	// As a fallback, we resolve relative to the repo root.
	const root = await pi.exec("git", ["rev-parse", "--show-toplevel"]);
	if (root.code === 0) {
		return `${root.stdout.trim()}/${relPath}`;
	}

	return relPath;
}

/** Remove a review worktree and its tracking branch. */
export async function removeWorktree(
	pi: ExtensionAPI,
	prNumber: number,
): Promise<void> {
	const branchName = `pr-review-${prNumber}`;
	const worktreePath = `${WORKTREE_DIR}/${branchName}`;

	await pi.exec("git", ["worktree", "remove", worktreePath, "--force"]);
	await pi.exec("git", ["branch", "-D", branchName]);
}

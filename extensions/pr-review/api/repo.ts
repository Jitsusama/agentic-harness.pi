/**
 * Repository resolution for PR review — wraps the shared
 * repo-discovery primitives with pr-review-specific logic
 * for resolving where a PR should be reviewed.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	findRepoOnDisk,
	getCurrentRepo,
	getRepoRoot,
	openInNewTab,
} from "../../lib/github/repo-discovery.js";

/** Result of resolving a repo for PR review. */
export type RepoResult =
	| { status: "current"; repoPath: string }
	| { status: "switched"; repoPath: string }
	| { status: "switch-failed"; repoPath: string }
	| { status: "not-found" };

/**
 * Resolve the repository for a PR review.
 *
 * Checks if the current directory is the target repo. If not,
 * searches common locations on disk. If found elsewhere, opens
 * a new terminal tab with pi pre-loaded. When a user request
 * is provided, it becomes the new tab's initial prompt so the
 * agent there can replicate the user's intent.
 */
export async function resolveRepo(
	pi: ExtensionAPI,
	owner: string,
	repo: string,
	prNumber: number,
	userRequest: string | null = null,
): Promise<RepoResult> {
	const current = await getCurrentRepo(pi);
	if (current?.owner === owner && current?.repo === repo) {
		const repoPath = await getRepoRoot(pi);
		return { status: "current", repoPath: repoPath ?? process.cwd() };
	}

	const repoPath = findRepoOnDisk(owner, repo);
	if (!repoPath) {
		return { status: "not-found" };
	}

	const prompt = userRequest ?? `review ${owner}/${repo}#${prNumber}`;
	const opened = await openInNewTab(pi, repoPath, prompt);
	if (opened) {
		return { status: "switched", repoPath };
	}

	return { status: "switch-failed", repoPath };
}

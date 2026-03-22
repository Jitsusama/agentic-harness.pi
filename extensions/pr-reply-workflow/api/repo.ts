/**
 * Branch and PR discovery for pr-reply: helpers for finding
 * the current branch, associated PRs and dependent PRs.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { parsePRReference } from "../../lib/github/pr-reference.js";
import { getCurrentRepo } from "../../lib/github/repo-discovery.js";
import type { PRReference } from "./github.js";

// Re-export for other pr-reply modules.
export { getCurrentRepo };

/**
 * Resolve a PR reference from user input or the current branch.
 * Tries explicit input first, then falls back to detecting the
 * PR associated with the current branch.
 */
export async function resolvePR(
	pi: ExtensionAPI,
	prInput: string | null,
): Promise<PRReference | null> {
	if (prInput) {
		const currentRepo = await getCurrentRepo(pi);
		const ref = parsePRReference(
			prInput,
			currentRepo?.owner,
			currentRepo?.repo,
		);
		if (ref) return ref;
	}

	const currentRepo = await getCurrentRepo(pi);
	const currentBranch = await getCurrentBranch(pi);

	if (currentRepo && currentBranch) {
		const prNumber = await findPRForBranch(
			pi,
			currentRepo.owner,
			currentRepo.repo,
			currentBranch,
		);

		if (prNumber) {
			return {
				owner: currentRepo.owner,
				repo: currentRepo.repo,
				number: prNumber,
			};
		}
	}

	return null;
}

/** Get the current branch name. */
export async function getCurrentBranch(
	pi: ExtensionAPI,
): Promise<string | null> {
	const result = await pi.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"]);

	if (result.code !== 0) return null;
	return result.stdout.trim();
}

/** Find the PR number associated with the current branch. */
export async function findPRForBranch(
	pi: ExtensionAPI,
	owner: string,
	repo: string,
	branch: string,
): Promise<number | null> {
	const result = await pi.exec("gh", [
		"pr",
		"list",
		"--repo",
		`${owner}/${repo}`,
		"--head",
		branch,
		"--json",
		"number",
		"--jq",
		".[0].number",
	]);

	if (result.code !== 0 || !result.stdout.trim()) return null;

	const prNumber = Number.parseInt(result.stdout.trim(), 10);
	return Number.isNaN(prNumber) ? null : prNumber;
}

/** Find dependent PRs (PRs whose base is the given branch). */
export async function findDependentPRs(
	pi: ExtensionAPI,
	owner: string,
	repo: string,
	branch: string,
): Promise<number[]> {
	const result = await pi.exec("gh", [
		"pr",
		"list",
		"--repo",
		`${owner}/${repo}`,
		"--base",
		branch,
		"--json",
		"number",
		"--jq",
		".[].number",
	]);

	if (result.code !== 0 || !result.stdout.trim()) return [];

	return result.stdout
		.trim()
		.split("\n")
		.map((n) => Number.parseInt(n, 10))
		.filter((n) => !Number.isNaN(n));
}

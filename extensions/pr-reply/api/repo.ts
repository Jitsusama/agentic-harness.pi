/**
 * Repository resolution for PR reply — wraps the shared
 * repo-discovery primitives with pr-reply-specific logic
 * for switching repos and finding dependent PRs.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	findRepoOnDisk,
	getCurrentRepo,
	openInNewTab,
} from "../../lib/github/repo-discovery.js";
import type { PRReference } from "./github.js";

// Re-export shared utilities used directly by other pr-reply modules.
export { getCurrentRepo } from "../../lib/github/repo-discovery.js";

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

/** Result of attempting to switch to a repo. */
export type SwitchResult =
	| { status: "already-here" }
	| { status: "opened-tab"; repoPath: string }
	| { status: "not-found-opened-tab-failed"; repoPath: string }
	| { status: "not-found" };

/**
 * Ensure we're in the correct repository for the PR.
 *
 * Returns a structured result so the caller can give the LLM
 * a clear message about what happened.
 */
export async function switchToRepo(
	pi: ExtensionAPI,
	ref: PRReference,
): Promise<SwitchResult> {
	const current = await getCurrentRepo(pi);
	if (current?.owner === ref.owner && current?.repo === ref.repo) {
		return { status: "already-here" };
	}

	const repoPath = findRepoOnDisk(ref.owner, ref.repo);
	if (!repoPath) {
		return { status: "not-found" };
	}

	const prompt = `respond to reviews on ${ref.owner}/${ref.repo}#${ref.number}`;
	const opened = await openInNewTab(pi, repoPath, prompt);
	if (opened) {
		return { status: "opened-tab", repoPath };
	}

	return { status: "not-found-opened-tab-failed", repoPath };
}

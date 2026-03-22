/**
 * Dependency chain discovery: walks the PR stack to find
 * dependent PRs that may need rebasing after changes are
 * pushed to the current PR's branch.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { findDependentPRs } from "./api/repo.js";
import { briefRebaseApproved } from "./briefing.js";
import type { DependentPR, PRReplyState } from "./state.js";
import { showRebasePanel } from "./ui/panels.js";

/**
 * Check for dependent PRs and offer a rebase if any exist.
 * Returns a rebase briefing string if the user approves, null
 * otherwise.
 */
export async function checkDependentPRs(
	state: PRReplyState,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): Promise<string | null> {
	if (!state.owner || !state.repo || !state.branch) return null;

	const chain = await walkDependencyChain(
		pi,
		state.owner,
		state.repo,
		state.branch,
	);
	if (chain.length === 0) return null;

	const choice = await showRebasePanel(ctx, chain);

	if (choice === "rebase") {
		return briefRebaseApproved(chain);
	}

	return null;
}

/**
 * Recursively find all PRs in the dependency chain.
 * Returns them in rebase order (closest dependent first).
 */
async function walkDependencyChain(
	pi: ExtensionAPI,
	owner: string,
	repo: string,
	branch: string,
): Promise<DependentPR[]> {
	const chain: DependentPR[] = [];
	const visited = new Set<string>();
	let currentBranch = branch;

	while (true) {
		if (visited.has(currentBranch)) break;
		visited.add(currentBranch);

		const dependentNumbers = await findDependentPRs(
			pi,
			owner,
			repo,
			currentBranch,
		);
		if (dependentNumbers.length === 0) break;

		const info = await fetchPRInfo(pi, owner, repo, dependentNumbers[0]);
		chain.push(info);
		currentBranch = info.branch;
	}

	return chain;
}

/** Fetch basic info about a PR for the dependency chain. */
async function fetchPRInfo(
	pi: ExtensionAPI,
	owner: string,
	repo: string,
	prNumber: number,
): Promise<DependentPR> {
	const result = await pi.exec("gh", [
		"pr",
		"view",
		String(prNumber),
		"--repo",
		`${owner}/${repo}`,
		"--json",
		"number,title,headRefName",
	]);

	if (result.code === 0) {
		try {
			const data = JSON.parse(result.stdout);
			return {
				number: data.number ?? prNumber,
				title: data.title ?? `PR #${prNumber}`,
				branch: data.headRefName ?? "unknown",
			};
		} catch {
			/* Parse failure: fall through to default */
		}
	}

	return { number: prNumber, title: `PR #${prNumber}`, branch: "unknown" };
}

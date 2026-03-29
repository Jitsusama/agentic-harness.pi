/**
 * Repository and branch resolution for pr-reply: resolves
 * which PR to work on from user input or the current branch.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { parsePRReference } from "../../../lib/internal/github/pr-reference.js";
import { getCurrentRepo } from "../../../lib/internal/github/repo-discovery.js";
import { findPRForBranch, type PRReference } from "./github.js";

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

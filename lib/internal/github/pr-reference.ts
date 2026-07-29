/**
 * PR reference parsing, in the shape pr-workflow still wants.
 *
 * The patterns themselves have moved to the GitHub review
 * provider, which is their long-term home; this is the adapter
 * that keeps pr-workflow compiling while it is re-pointed onto
 * the review substrate. Delete it once nothing imports
 * `PRReference` any more.
 */

import {
	claimGitHubReference,
	githubRepoKey,
	ownerRepoFromKey,
	ownerRepoFromRemote,
} from "../../review/providers/github/claims.js";

/** Identifies a specific pull request on GitHub. */
export interface PRReference {
	readonly owner: string;
	readonly repo: string;
	readonly number: number;
}

/**
 * Parse a PR reference from user input.
 *
 * Accepts a pull request URL, a Graphite URL, the
 * `owner/repo#123` short form, or a bare number when a default
 * owner and repo are supplied.
 *
 * Returns null if input doesn't match any known pattern.
 */
export function parsePRReference(
	input: string,
	defaultOwner?: string,
	defaultRepo?: string,
): PRReference | null {
	const fallback =
		defaultOwner && defaultRepo
			? { key: githubRepoKey(defaultOwner, defaultRepo) }
			: undefined;
	const change = claimGitHubReference(input, fallback);
	if (!change) return null;
	const owned = ownerRepoFromKey(change.repo.key);
	if (!owned) return null;
	return {
		owner: owned.owner,
		repo: owned.repo,
		number: Number.parseInt(change.id, 10),
	};
}

/**
 * Extract owner and repo from a git remote URL. Handles HTTPS
 * with or without credentials, and SSH.
 *
 * Returns null if the URL doesn't match GitHub patterns.
 */
export function extractOwnerRepo(
	remoteUrl: string,
): { owner: string; repo: string } | null {
	return ownerRepoFromRemote(remoteUrl);
}

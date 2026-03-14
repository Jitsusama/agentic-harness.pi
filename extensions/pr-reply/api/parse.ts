/**
 * PR link parsing — extract owner/repo/number from various formats.
 */

import type { PRReference } from "./github.js";

/** PR link patterns we recognize. */
const GITHUB_URL_PATTERN =
	/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/;
const SHORT_FORM_PATTERN = /^([^/]+)\/([^/#]+)#(\d+)$/; // owner/repo#123
const NUMBER_ONLY_PATTERN = /^#(\d+)$/; // #123

/**
 * Parse a PR reference from user input.
 * Returns null if input doesn't match any known pattern.
 */
export function parsePRReference(
	input: string,
	defaultOwner?: string,
	defaultRepo?: string,
): PRReference | null {
	const trimmed = input.trim();

	// Try GitHub URL
	const urlMatch = trimmed.match(GITHUB_URL_PATTERN);
	if (urlMatch) {
		return {
			owner: urlMatch[1],
			repo: urlMatch[2],
			number: Number.parseInt(urlMatch[3], 10),
		};
	}

	// Try short form (owner/repo#123)
	const shortMatch = trimmed.match(SHORT_FORM_PATTERN);
	if (shortMatch) {
		return {
			owner: shortMatch[1],
			repo: shortMatch[2],
			number: Number.parseInt(shortMatch[3], 10),
		};
	}

	// Try number only (#123) — requires defaults
	const numberMatch = trimmed.match(NUMBER_ONLY_PATTERN);
	if (numberMatch && defaultOwner && defaultRepo) {
		return {
			owner: defaultOwner,
			repo: defaultRepo,
			number: Number.parseInt(numberMatch[1], 10),
		};
	}

	return null;
}

/**
 * Extract owner and repo from a Git remote URL.
 * Returns null if the URL doesn't match GitHub patterns.
 */
export function extractOwnerRepo(remoteUrl: string): {
	owner: string;
	repo: string;
} | null {
	// HTTPS: https://github.com/owner/repo.git
	const httpsMatch = remoteUrl.match(
		/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/,
	);
	if (httpsMatch) {
		return { owner: httpsMatch[1], repo: httpsMatch[2] };
	}

	// SSH: git@github.com:owner/repo.git
	const sshMatch = remoteUrl.match(
		/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/,
	);
	if (sshMatch) {
		return { owner: sshMatch[1], repo: sshMatch[2] };
	}

	return null;
}

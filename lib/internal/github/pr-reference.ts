/**
 * PR reference parsing: extract owner/repo/number from URLs,
 * short forms, and bare numbers. Also extracts owner/repo from
 * git remote URLs.
 *
 * Used by both pr-review-workflow and pr-reply-workflow extensions.
 */

/** Identifies a specific pull request on GitHub. */
export interface PRReference {
	readonly owner: string;
	readonly repo: string;
	readonly number: number;
}

/** PR link patterns we recognize. */
const GITHUB_URL_PATTERN =
	/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/;
const SHORT_FORM_PATTERN = /^([^/]+)\/([^/#]+)#(\d+)$/;
const NUMBER_ONLY_PATTERN = /^#?(\d+)$/;

/**
 * Parse a PR reference from user input.
 *
 * Accepts:
 *   - Full URL: https://github.com/owner/repo/pull/123
 *   - Short form: owner/repo#123
 *   - Number: #123 or 123 (requires defaultOwner/defaultRepo)
 *
 * Returns null if input doesn't match any known pattern.
 */
export function parsePRReference(
	input: string,
	defaultOwner?: string,
	defaultRepo?: string,
): PRReference | null {
	const trimmed = input.trim();

	const urlMatch = trimmed.match(GITHUB_URL_PATTERN);
	if (urlMatch) {
		return {
			owner: urlMatch[1],
			repo: urlMatch[2],
			number: Number.parseInt(urlMatch[3], 10),
		};
	}

	const shortMatch = trimmed.match(SHORT_FORM_PATTERN);
	if (shortMatch) {
		return {
			owner: shortMatch[1],
			repo: shortMatch[2],
			number: Number.parseInt(shortMatch[3], 10),
		};
	}

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
 * Extract owner and repo from a git remote URL.
 *
 * Handles:
 *   - HTTPS: https://github.com/owner/repo.git
 *   - HTTPS with credentials: https://user:token@github.com/owner/repo.git
 *   - SSH: git@github.com:owner/repo.git
 *
 * Returns null if the URL doesn't match GitHub patterns.
 */
export function extractOwnerRepo(
	remoteUrl: string,
): { owner: string; repo: string } | null {
	// HTTPS, with optional user:pass@ credentials (e.g. x-access-token:TOKEN@).
	const httpsMatch = remoteUrl.match(
		/^https?:\/\/(?:[^@]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/,
	);
	if (httpsMatch) {
		return { owner: httpsMatch[1], repo: httpsMatch[2] };
	}

	const sshMatch = remoteUrl.match(
		/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/,
	);
	if (sshMatch) {
		return { owner: sshMatch[1], repo: sshMatch[2] };
	}

	return null;
}

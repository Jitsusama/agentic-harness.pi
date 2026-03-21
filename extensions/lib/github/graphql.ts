/**
 * Shared GraphQL runner: execute typed GraphQL queries via
 * the `gh` CLI.
 *
 * Used by pr-review and pr-reply for all GitHub GraphQL
 * interactions. Provides type-safe responses with automatic
 * error handling.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { PRReference } from "../parse/pr-reference.js";

/**
 * Execute a typed GraphQL query via `gh api graphql`.
 *
 * Passes owner, repo, and PR number as variables. The query
 * must declare `$owner: String!`, `$repo: String!`, and
 * `$pr: Int!` (or `$number: Int!`: use the appropriate
 * variable name in your query).
 */
export async function runGraphQL<T>(
	pi: ExtensionAPI,
	query: string,
	ref: PRReference,
): Promise<T> {
	const result = await pi.exec("gh", [
		"api",
		"graphql",
		"-f",
		`query=${query}`,
		"-F",
		`owner=${ref.owner}`,
		"-F",
		`repo=${ref.repo}`,
		"-F",
		`pr=${ref.number}`,
	]);

	if (result.code !== 0) {
		throw new Error(`GitHub GraphQL error: ${result.stderr}`);
	}

	return JSON.parse(result.stdout);
}

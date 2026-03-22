/**
 * Shared GraphQL runner: execute typed GraphQL queries via
 * the `gh` CLI.
 *
 * Used by pr-review-workflow and pr-reply-workflow for all GitHub GraphQL
 * interactions. Provides type-safe responses with automatic
 * error handling.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/**
 * Execute a typed GraphQL query via `gh api graphql`.
 *
 * Each entry in `variables` becomes a `-f` (string) or `-F`
 * (number) flag. Callers declare matching `$name` parameters
 * in their query.
 */
export async function runGraphQL<T>(
	pi: ExtensionAPI,
	query: string,
	variables: Record<string, string | number>,
): Promise<T> {
	const args = ["api", "graphql", "-f", `query=${query}`];

	for (const [name, value] of Object.entries(variables)) {
		// The gh CLI uses -f for raw strings and -F for numeric coercion.
		const flag = typeof value === "number" ? "-F" : "-f";
		args.push(flag, `${name}=${value}`);
	}

	const result = await pi.exec("gh", args);

	if (result.code !== 0) {
		throw new Error(`GitHub GraphQL error: ${result.stderr}`);
	}

	return JSON.parse(result.stdout);
}

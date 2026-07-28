/**
 * Fetching a pull request's diff from GitHub.
 *
 * Parsing used to live here too, alongside a diff model of its
 * own. Both moved to `lib/review`, which parses the same text
 * more carefully and is not GitHub's alone. What is left is the
 * one thing that genuinely needs the `gh` CLI, and that goes
 * when the review engine owns the fetch.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PRReference } from "./pr-reference.js";

/** Fetch the unified diff for a PR via gh CLI. */
export async function fetchDiff(
	pi: ExtensionAPI,
	ref: PRReference,
): Promise<string> {
	const result = await pi.exec("gh", [
		"pr",
		"diff",
		String(ref.number),
		"--repo",
		`${ref.owner}/${ref.repo}`,
	]);

	if (result.code !== 0) {
		throw new Error(`Failed to fetch diff: ${result.stderr}`);
	}

	return result.stdout;
}

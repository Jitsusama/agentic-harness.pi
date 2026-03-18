/**
 * Post PR reviews to GitHub — shared temp-file posting pattern.
 *
 * Both pr-annotate and pr-review need to post review comments
 * via `gh api`. The JSON payload is written to a temp file to
 * avoid shell escaping issues with special characters in
 * comment bodies (backticks, single quotes, newlines).
 */

import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { PRReference } from "../parse/pr-reference.js";

/** A comment in the GitHub review API format. */
export interface ReviewAPIComment {
	path: string;
	line: number;
	start_line?: number;
	side: string;
	start_side?: string;
	body: string;
}

/**
 * Post a review with comments to GitHub via `gh api`.
 *
 * Writes the JSON payload to a temp file, calls `gh api`
 * with `--input`, and cleans up the temp file afterward.
 *
 * @param event - GitHub review event: "COMMENT", "APPROVE",
 *   or "REQUEST_CHANGES"
 */
export async function postReview(
	pi: ExtensionAPI,
	ref: PRReference,
	event: string,
	body: string,
	comments: ReviewAPIComment[],
): Promise<void> {
	const payload = JSON.stringify({ event, body, comments });

	const tmpFile = join(tmpdir(), `pi-pr-review-${Date.now()}.json`);
	try {
		writeFileSync(tmpFile, payload, "utf-8");

		const result = await pi.exec("gh", [
			"api",
			"--method",
			"POST",
			`repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/reviews`,
			"--input",
			tmpFile,
		]);

		if (result.code !== 0) {
			throw new Error(result.stderr || "gh api failed");
		}
	} finally {
		try {
			unlinkSync(tmpFile);
		} catch {
			/* Temp file cleanup — safe to ignore */
		}
	}
}

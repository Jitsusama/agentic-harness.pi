/**
 * Post review comments to GitHub via `gh api`.
 *
 * Uses start_line + line for multi-line ranges when
 * startLine is provided on the comment.
 *
 * The JSON payload is written to a temp file to avoid shell
 * escaping issues with special characters in comment bodies.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { ReviewComment } from "./index.js";

interface PostResult {
	error?: string;
}

export async function postReview(
	pi: ExtensionAPI,
	pr: number,
	comments: ReviewComment[],
	body?: string,
	repo?: string,
): Promise<PostResult> {
	const reviewComments = comments.map((c) => {
		const comment: Record<string, unknown> = {
			path: c.path,
			line: c.line,
			side: c.side,
			body: c.body,
		};
		if (c.startLine) {
			comment.start_line = c.startLine;
			comment.start_side = c.side;
		}
		return comment;
	});

	const payload = JSON.stringify({
		event: "COMMENT",
		body: body || "",
		comments: reviewComments,
	});

	// Write payload to temp file to avoid shell escaping issues
	// with single quotes, backticks, and newlines in comment bodies.
	const tmpFile = path.join(os.tmpdir(), `pi-pr-review-${Date.now()}.json`);
	try {
		fs.writeFileSync(tmpFile, payload, "utf-8");

		const repoFlag = repo ? ` -R ${repo}` : "";
		const command = `gh api --method POST${repoFlag} repos/{owner}/{repo}/pulls/${pr}/reviews --input ${tmpFile}`;

		const result = await pi.exec("bash", ["-c", command], {
			timeout: 15000,
		});

		if (result.code !== 0) {
			return { error: result.stderr || "gh api failed" };
		}

		return {};
	} finally {
		try {
			fs.unlinkSync(tmpFile);
		} catch {
			/* Temp file cleanup — safe to ignore */
		}
	}
}

/**
 * Post review comments to GitHub via `gh api`.
 *
 * Uses start_line + line for multi-line ranges when
 * startLine is provided on the comment.
 */

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

	const repoFlag = repo ? ` -R ${repo}` : "";
	const escaped = payload.replace(/'/g, "'\\''");
	const command = `echo '${escaped}' | gh api --method POST${repoFlag} repos/{owner}/{repo}/pulls/${pr}/reviews --input -`;

	const result = await pi.exec("bash", ["-c", command], {
		timeout: 15000,
	});

	if (result.code !== 0) {
		return { error: result.stderr || "gh api failed" };
	}

	return {};
}

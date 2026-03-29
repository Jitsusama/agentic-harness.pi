/**
 * Post PR reviews to GitHub: shared temp-file posting pattern.
 *
 * Both pr-annotate-workflow and pr-review-workflow need to post review comments
 * via `gh api`. The JSON payload is written to a temp file to
 * avoid shell escaping issues with special characters in
 * comment bodies (backticks, single quotes, newlines).
 */

import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { PRReference } from "./pr-reference.js";

/** A review comment in domain-level format. */
export interface ReviewComment {
	readonly path: string;
	readonly line: number;
	readonly startLine?: number;
	/** Diff side: defaults to "RIGHT" when omitted. */
	readonly side?: string;
	readonly body: string;
}

/**
 * Post a review with comments to GitHub via `gh api`.
 *
 * Transforms ReviewComment objects into GitHub's wire format
 * (snake_case fields), writes the JSON payload to a temp file,
 * and posts via `gh api --input`.
 *
 * @param event - GitHub review event: "COMMENT", "APPROVE",
 *   or "REQUEST_CHANGES"
 */
export async function postReview(
	pi: ExtensionAPI,
	ref: PRReference,
	event: string,
	body: string,
	comments: ReviewComment[],
): Promise<void> {
	const wireComments = comments.map(toWireFormat);
	const payload = JSON.stringify({ event, body, comments: wireComments });

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
			/* Temp file cleanup: safe to ignore */
		}
	}
}

/** Transform a domain-level ReviewComment into GitHub's wire format. */
function toWireFormat(comment: ReviewComment): Record<string, unknown> {
	const side = comment.side ?? "RIGHT";
	const wire: Record<string, unknown> = {
		path: comment.path,
		line: comment.line,
		side,
		body: comment.body,
	};
	if (comment.startLine !== undefined) {
		wire.start_line = comment.startLine;
		wire.start_side = side;
	}
	return wire;
}

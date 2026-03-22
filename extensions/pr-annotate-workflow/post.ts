/**
 * Post review comments to GitHub: transforms pr-annotate's
 * ReviewComment format into GitHub API format and delegates
 * to the shared review posting module.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { PRReference } from "../lib/github/pr-reference.js";
import { getCurrentRepo } from "../lib/github/repo-discovery.js";
import {
	postReview as postReviewAPI,
	type ReviewAPIComment,
} from "../lib/github/review-post.js";
import type { ReviewComment } from "./index.js";

interface PostResult {
	error?: string;
}

/**
 * Post review comments for a PR.
 *
 * Transforms ReviewComment objects into GitHub API format
 * and posts them as a single COMMENT review.
 */
export async function postReview(
	pi: ExtensionAPI,
	pr: number,
	comments: ReviewComment[],
	body?: string,
	repo?: string,
): Promise<PostResult> {
	const reviewComments: ReviewAPIComment[] = comments.map((c) => {
		const comment: ReviewAPIComment = {
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

	const ref = await buildRef(pi, pr, repo);
	if (!ref) {
		return {
			error: "Could not determine repository. Provide a repo parameter.",
		};
	}

	try {
		await postReviewAPI(pi, ref, "COMMENT", body || "", reviewComments);
		return {};
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { error: msg };
	}
}

/**
 * Build a PRReference from a PR number and optional repo string.
 * Falls back to the current git remote when repo is omitted.
 */
async function buildRef(
	pi: ExtensionAPI,
	pr: number,
	repo?: string,
): Promise<PRReference | null> {
	if (repo) {
		const parts = repo.split("/");
		if (parts.length === 2) {
			return { owner: parts[0], repo: parts[1], number: pr };
		}
	}

	const current = await getCurrentRepo(pi);
	if (current) {
		return { owner: current.owner, repo: current.repo, number: pr };
	}

	return null;
}

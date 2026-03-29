/**
 * Post review comments to GitHub: transforms pr-annotate's
 * ProposedComment format into the shared ReviewComment type
 * and delegates to the shared review posting module.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { PRReference } from "../../lib/internal/github/pr-reference.js";
import { getCurrentRepo } from "../../lib/internal/github/repo-discovery.js";
import {
	postReview as postReviewShared,
	type ReviewComment,
} from "../../lib/internal/github/review-post.js";
import type { ProposedComment } from "./types.js";

interface PostResult {
	error?: string;
}

/**
 * Post review comments for a PR.
 *
 * Strips rationale from ProposedComment objects and posts
 * them as a single COMMENT review.
 */
export async function postReview(
	pi: ExtensionAPI,
	pr: number,
	comments: ProposedComment[],
	body?: string,
	repo?: string,
): Promise<PostResult> {
	const reviewComments: ReviewComment[] = comments.map((c) => ({
		path: c.path,
		line: c.line,
		startLine: c.startLine,
		side: c.side,
		body: c.body,
	}));

	const ref = await buildRef(pi, pr, repo);
	if (!ref) {
		return {
			error: "Could not determine repository. Provide a repo parameter.",
		};
	}

	try {
		await postReviewShared(pi, ref, "COMMENT", body || "", reviewComments);
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

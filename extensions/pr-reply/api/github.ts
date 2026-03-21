/**
 * GitHub API integration: fetch reviews and threads, post replies.
 *
 * Uses two separate queries:
 *   1. reviewThreads: thread-level data (isResolved, isOutdated,
 *      line numbers) with nested comments
 *   2. reviews: review-level data (state, body, author)
 *
 * This approach gives us accurate resolved/outdated status that
 * isn't available when parsing threads from review comments alone.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { runGraphQL } from "../../lib/github/graphql.js";
import type { PRReference } from "../../lib/parse/pr-reference.js";
import type { Comment, Review, ReviewState, Thread } from "../state.js";

export type { PRReference };

// ---- GraphQL response shapes ----

interface GQLComment {
	id: string;
	databaseId: number;
	body: string;
	createdAt: string;
	isMinimized: boolean;
	author: { login: string } | null;
	replyTo: { id: string } | null;
	pullRequestReview: { id: string; state: ReviewState } | null;
}

interface GQLThread {
	id: string;
	isResolved: boolean;
	isOutdated: boolean;
	path: string;
	line: number | null;
	originalLine: number | null;
	startLine: number | null;
	comments: { nodes: GQLComment[] };
}

interface GQLReview {
	id: string;
	state: ReviewState;
	submittedAt: string;
	body: string;
	author: { login: string } | null;
}

// ---- GraphQL response shapes ----

/** Response from the THREADS_QUERY. */
interface ThreadsResponse {
	data: {
		repository: {
			pullRequest: {
				reviewThreads: { nodes: GQLThread[] };
			};
		};
	};
}

/** Response from the REVIEWS_QUERY. */
interface ReviewsResponse {
	data: {
		repository: {
			pullRequest: {
				reviews: { nodes: GQLReview[] };
			};
		};
	};
}

/** Response from the refresh thread comments query. */
interface RefreshThreadsResponse {
	data: {
		repository: {
			pullRequest: {
				reviewThreads: {
					nodes: Array<{
						id: string;
						isResolved: boolean;
						comments: { nodes: GQLComment[] };
					}>;
				};
			};
		};
	};
}

// ---- Queries ----

const THREADS_QUERY = `
query($owner: String!, $repo: String!, $pr: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          originalLine
          startLine
          comments(first: 100) {
            nodes {
              id
              databaseId
              body
              createdAt
              isMinimized
              author { login }
              replyTo { id }
              pullRequestReview {
                id
                state
              }
            }
          }
        }
      }
    }
  }
}`;

const REVIEWS_QUERY = `
query($owner: String!, $repo: String!, $pr: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      reviews(first: 100) {
        nodes {
          id
          state
          submittedAt
          body
          author { login }
        }
      }
    }
  }
}`;

// ---- Public API ----

/**
 * Fetch reviews and comment threads for a PR.
 * Uses reviewThreads for accurate resolved/outdated status.
 */
export async function fetchReviews(
	pi: ExtensionAPI,
	ref: PRReference,
): Promise<{ reviews: Review[]; threads: Thread[] }> {
	const [threadsData, reviewsData] = await Promise.all([
		runGraphQL<ThreadsResponse>(pi, THREADS_QUERY, ref),
		runGraphQL<ReviewsResponse>(pi, REVIEWS_QUERY, ref),
	]);

	const gqlThreads =
		threadsData.data.repository.pullRequest.reviewThreads.nodes;
	const gqlReviews = reviewsData.data.repository.pullRequest.reviews.nodes;

	const reviews = parseReviews(gqlReviews);
	const threads = parseThreads(gqlThreads, reviews);

	return { reviews, threads };
}

/**
 * Post a reply to a review comment thread.
 * Uses the REST API with in_reply_to for correct threading.
 */
export async function postReply(
	pi: ExtensionAPI,
	ref: PRReference,
	commentDatabaseId: number,
	body: string,
): Promise<void> {
	const result = await pi.exec("gh", [
		"api",
		"-X",
		"POST",
		`repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/comments`,
		"-f",
		`body=${body}`,
		"-F",
		`in_reply_to=${commentDatabaseId}`,
	]);

	if (result.code !== 0) {
		throw new Error(`Failed to post reply: ${result.stderr}`);
	}
}

// ---- Parsing ----

/** Parse raw GraphQL reviews into Review objects. */
function parseReviews(gqlReviews: GQLReview[]): Review[] {
	return gqlReviews.map((r) => ({
		id: r.id,
		author: r.author?.login ?? "unknown",
		state: r.state,
		submittedAt: r.submittedAt,
		body: r.body,
		threadIds: [], // Populated below when parsing threads
	}));
}

/**
 * Parse raw GraphQL threads into Thread objects.
 * Links threads to their originating review and sorts by
 * file, line, then timestamp.
 */
function parseThreads(gqlThreads: GQLThread[], reviews: Review[]): Thread[] {
	const threads: Thread[] = [];

	for (const gt of gqlThreads) {
		const comments = parseComments(gt.comments.nodes);
		if (comments.length === 0) continue;

		const firstComment = gt.comments.nodes[0];
		const reviewId = firstComment?.pullRequestReview?.id ?? "";
		const reviewState = firstComment?.pullRequestReview?.state ?? "COMMENTED";
		const reviewer = firstComment?.author?.login ?? "unknown";

		const thread: Thread = {
			id: gt.id,
			reviewId,
			reviewer,
			reviewState,
			file: gt.path,
			line: gt.line ?? 0,
			originalLine:
				gt.originalLine !== null && gt.originalLine !== gt.line
					? gt.originalLine
					: null,
			startLine: gt.startLine,
			comments,
			isOutdated: gt.isOutdated,
			isResolved: gt.isResolved,
		};

		threads.push(thread);

		const review = reviews.find((r) => r.id === reviewId);
		if (review && !review.threadIds.includes(gt.id)) {
			review.threadIds.push(gt.id);
		}
	}

	threads.sort((a, b) => {
		if (a.file !== b.file) return a.file.localeCompare(b.file);
		if (a.line !== b.line) return a.line - b.line;
		const aTime = new Date(a.comments[0]?.createdAt ?? 0).getTime();
		const bTime = new Date(b.comments[0]?.createdAt ?? 0).getTime();
		return aTime - bTime;
	});

	return threads;
}

/** Parse raw GraphQL comments, filtering minimized ones. */
function parseComments(gqlComments: GQLComment[]): Comment[] {
	return gqlComments
		.filter((c) => !c.isMinimized)
		.map((c) => ({
			id: c.id,
			databaseId: c.databaseId,
			author: c.author?.login ?? "unknown",
			body: c.body,
			createdAt: c.createdAt,
			inReplyTo: c.replyTo?.id ?? null,
		}))
		.sort(
			(a, b) =>
				new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
		);
}

/**
 * Re-fetch a single thread's comments to get the latest conversation.
 * Updates the thread in place with fresh comment data.
 */
export async function refreshThreadComments(
	pi: ExtensionAPI,
	ref: PRReference,
	thread: Thread,
): Promise<void> {
	const query = `
query($owner: String!, $repo: String!, $pr: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          comments(first: 100) {
            nodes {
              id
              databaseId
              body
              createdAt
              isMinimized
              author { login }
              replyTo { id }
            }
          }
        }
      }
    }
  }
}`;

	try {
		const data = await runGraphQL<RefreshThreadsResponse>(pi, query, ref);
		const threads = data.data.repository.pullRequest.reviewThreads.nodes;

		const match = threads.find((t) => t.id === thread.id);
		if (match) {
			thread.comments = parseComments(match.comments.nodes);
			thread.isResolved = match.isResolved;
		}
	} catch {
		/* Refresh failed: use stale data rather than blocking */
	}
}

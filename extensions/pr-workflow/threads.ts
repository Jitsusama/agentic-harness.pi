/**
 * Fetch, parse and mutate GitHub PR review threads.
 *
 * Mirrors `fetch.ts`: the parser is pure; the runners
 * shell out via the shared `runGraphQL` helper. Splitting
 * them keeps the parser easy to test without stubbing
 * process boundaries.
 *
 * Threads here are the GraphQL `PullRequestReviewThread`
 * nodes: the conversation roots that collect inline review
 * comments. Reply targets a thread; resolve closes it.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { runGraphQL } from "../../lib/internal/github/graphql.js";
import type { PRReference } from "../../lib/internal/github/pr-reference.js";

/** Single comment inside a review thread. */
export interface ReviewThreadComment {
	readonly id: string;
	/** Login of the author. `"ghost"` for deleted accounts. */
	readonly author: string;
	readonly body: string;
	readonly createdAt: string;
	readonly url: string;
}

/** A review thread on a pull request. */
export interface ReviewThread {
	readonly id: string;
	readonly isResolved: boolean;
	readonly isOutdated: boolean;
	/** Null for PR-level threads (not anchored to a file). */
	readonly path: string | null;
	/** Null for PR-level threads or threads whose anchor was lost. */
	readonly line: number | null;
	readonly comments: ReviewThreadComment[];
}

const THREADS_QUERY = `query PrReviewThreads($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          comments(first: 50) {
            nodes {
              id
              author { login }
              body
              createdAt
              url
            }
          }
        }
      }
    }
  }
}`;

const REPLY_MUTATION = `mutation AddThreadReply($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: {
    pullRequestReviewThreadId: $threadId
    body: $body
  }) {
    comment { id url }
  }
}`;

const RESOLVE_MUTATION = `mutation ResolveThread($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) {
    thread { id isResolved }
  }
}`;

/**
 * Parse a raw GraphQL response into typed review threads.
 *
 * Throws if the response shape is unexpected. The caller is
 * responsible for catching and surfacing a useful message.
 */
export function parseReviewThreads(raw: unknown): ReviewThread[] {
	if (!isRecord(raw)) {
		throw new Error("Review threads response was not an object");
	}
	const data = raw.data;
	if (!isRecord(data)) {
		throw new Error("Review threads response is missing `data`");
	}
	const repository = data.repository;
	if (!isRecord(repository)) {
		throw new Error("Review threads: pull request not found");
	}
	const pr = repository.pullRequest;
	if (!isRecord(pr)) {
		throw new Error("Review threads: pull request not found");
	}
	const reviewThreads = pr.reviewThreads;
	if (!isRecord(reviewThreads)) {
		throw new Error("Review threads: `reviewThreads` missing");
	}
	const nodes = reviewThreads.nodes;
	if (!Array.isArray(nodes)) {
		throw new Error("Review threads: `nodes` is not an array");
	}
	return nodes.map(parseThreadNode);
}

function parseThreadNode(node: unknown): ReviewThread {
	if (!isRecord(node)) {
		throw new Error("Review thread node was not an object");
	}
	const commentsBlock = node.comments;
	if (!isRecord(commentsBlock)) {
		throw new Error("Review thread: `comments` missing");
	}
	const commentNodes = commentsBlock.nodes;
	if (!Array.isArray(commentNodes)) {
		throw new Error("Review thread: `comments.nodes` is not an array");
	}
	return {
		id: expectString(node, "id"),
		isResolved: expectBoolean(node, "isResolved"),
		isOutdated: expectBoolean(node, "isOutdated"),
		path: expectNullableString(node, "path"),
		line: expectNullableNumber(node, "line"),
		comments: commentNodes.map(parseCommentNode),
	};
}

function parseCommentNode(node: unknown): ReviewThreadComment {
	if (!isRecord(node)) {
		throw new Error("Review thread comment was not an object");
	}
	const author = node.author;
	const authorLogin =
		author === null || author === undefined
			? "ghost"
			: isRecord(author)
				? expectString(author, "login")
				: (() => {
						throw new Error(
							"Review thread comment: `author` has unexpected shape",
						);
					})();
	return {
		id: expectString(node, "id"),
		author: authorLogin,
		body: expectString(node, "body"),
		createdAt: expectString(node, "createdAt"),
		url: expectString(node, "url"),
	};
}

/** Round-trip a review-threads request through `gh api graphql`. */
export async function fetchReviewThreads(
	pi: ExtensionAPI,
	reference: PRReference,
): Promise<ReviewThread[]> {
	const raw = await runGraphQL<unknown>(pi, THREADS_QUERY, {
		owner: reference.owner,
		repo: reference.repo,
		number: reference.number,
	});
	return parseReviewThreads(raw);
}

/** Reply to an existing thread. Returns the new comment URL. */
export async function replyToThread(
	pi: ExtensionAPI,
	threadId: string,
	body: string,
): Promise<string> {
	const raw = await runGraphQL<unknown>(pi, REPLY_MUTATION, {
		threadId,
		body,
	});
	const comment = extractReplyComment(raw);
	return comment.url;
}

/** Resolve a thread. Returns the new resolved state. */
export async function resolveThread(
	pi: ExtensionAPI,
	threadId: string,
): Promise<boolean> {
	const raw = await runGraphQL<unknown>(pi, RESOLVE_MUTATION, { threadId });
	return extractResolvedState(raw);
}

function extractReplyComment(raw: unknown): { url: string } {
	if (!isRecord(raw)) {
		throw new Error("Reply response was not an object");
	}
	const data = raw.data;
	if (!isRecord(data)) {
		throw new Error("Reply response missing `data`");
	}
	const payload = data.addPullRequestReviewThreadReply;
	if (!isRecord(payload)) {
		throw new Error("Reply response missing payload");
	}
	const comment = payload.comment;
	if (!isRecord(comment)) {
		throw new Error("Reply response missing comment");
	}
	return { url: expectString(comment, "url") };
}

function extractResolvedState(raw: unknown): boolean {
	if (!isRecord(raw)) {
		throw new Error("Resolve response was not an object");
	}
	const data = raw.data;
	if (!isRecord(data)) {
		throw new Error("Resolve response missing `data`");
	}
	const payload = data.resolveReviewThread;
	if (!isRecord(payload)) {
		throw new Error("Resolve response missing payload");
	}
	const thread = payload.thread;
	if (!isRecord(thread)) {
		throw new Error("Resolve response missing thread");
	}
	return expectBoolean(thread, "isResolved");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectString(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	if (typeof value !== "string") {
		throw new Error(`Review threads: \`${key}\` is not a string`);
	}
	return value;
}

function expectNullableString(
	record: Record<string, unknown>,
	key: string,
): string | null {
	const value = record[key];
	if (value === null || value === undefined) {
		return null;
	}
	if (typeof value !== "string") {
		throw new Error(`Review threads: \`${key}\` is not a string or null`);
	}
	return value;
}

function expectNullableNumber(
	record: Record<string, unknown>,
	key: string,
): number | null {
	const value = record[key];
	if (value === null || value === undefined) {
		return null;
	}
	if (typeof value !== "number") {
		throw new Error(`Review threads: \`${key}\` is not a number or null`);
	}
	return value;
}

function expectBoolean(record: Record<string, unknown>, key: string): boolean {
	const value = record[key];
	if (typeof value !== "boolean") {
		throw new Error(`Review threads: \`${key}\` is not a boolean`);
	}
	return value;
}

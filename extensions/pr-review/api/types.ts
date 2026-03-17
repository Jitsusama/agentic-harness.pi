/**
 * GraphQL response types for PR review API queries.
 *
 * These mirror the exact shape returned by the GraphQL queries
 * in github.ts. Parsing functions receive typed data instead of
 * navigating unknown objects with casts.
 */

// ---- PR context query response ----

/** Response from the PR_CONTEXT_QUERY. */
export interface PRContextResponse {
	data: {
		repository: {
			pullRequest: GQLPullRequest;
		};
	};
}

/** PR node from the context query. */
export interface GQLPullRequest {
	title: string;
	body: string;
	state: string;
	author: GQLAuthor | null;
	headRefName: string;
	baseRefName: string;
	additions: number;
	deletions: number;
	changedFiles: number;
	comments: { nodes: GQLComment[] };
	closingIssuesReferences: { nodes: GQLIssue[] };
}

/** Issue node from closingIssuesReferences. */
export interface GQLIssue {
	number: number;
	title: string;
	body: string;
	state: string;
	labels: { nodes: GQLLabel[] };
	comments: { nodes: GQLComment[] };
}

/** Label node. */
export interface GQLLabel {
	name: string;
}

/** Comment node (used in both PR and issue comments). */
export interface GQLComment {
	author: GQLAuthor | null;
	body: string;
	createdAt: string;
}

/** Author node. */
export interface GQLAuthor {
	login: string;
}

// ---- Reviews query response ----

/** Response from the REVIEWS_QUERY. */
export interface ReviewsResponse {
	data: {
		repository: {
			pullRequest: {
				reviews: { nodes: GQLReview[] };
				reviewThreads: { nodes: GQLReviewThread[] };
			};
		};
	};
}

/** Review node. */
export interface GQLReview {
	id: string;
	state: string;
	submittedAt: string;
	body: string;
	author: GQLAuthor | null;
}

/** Review thread node. */
export interface GQLReviewThread {
	id: string;
	isResolved: boolean;
	path: string;
	line: number | null;
	comments: { nodes: GQLThreadComment[] };
}

/** Comment within a review thread. */
export interface GQLThreadComment {
	body: string;
	createdAt: string;
	author: GQLAuthor | null;
	pullRequestReview: { id: string } | null;
}

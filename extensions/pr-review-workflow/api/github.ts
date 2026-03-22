/**
 * GitHub API integration for PR review: fetch PR metadata,
 * diff, linked issues, and related context.
 *
 * Uses GraphQL for structured data and gh CLI for diffs.
 * Response types are defined in types.ts: parsing functions
 * receive typed data, no manual property navigation.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { runGraphQL } from "../../lib/github/graphql.js";
import type { PRReference } from "../../lib/github/pr-reference.js";
import type {
	IssueComment,
	LinkedIssue,
	PRMetadata,
	RelatedPR,
	Reviewer,
} from "../state.js";
import type { GQLIssue, GQLPullRequest, PRContextResponse } from "./types.js";

const PR_CONTEXT_QUERY = `
query($owner: String!, $repo: String!, $pr: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      title
      body
      state
      author { login }
      headRefName
      baseRefName
      additions
      deletions
      changedFiles
      comments(first: 50) {
        nodes { author { login } body createdAt }
      }
      closingIssuesReferences(first: 20) {
        nodes {
          number title body state
          labels(first: 10) { nodes { name } }
          comments(first: 30) {
            nodes { author { login } body createdAt }
          }
        }
      }
      reviewRequests(first: 20) {
        nodes {
          requestedReviewer {
            ... on User { login }
          }
        }
      }
      latestOpinionatedReviews(first: 20) {
        nodes {
          author { login }
          state
        }
      }
    }
  }
}`;

/**
 * Fetch PR metadata, linked issues, and reviewers via GraphQL.
 */
export async function fetchPRGraphQL(
	pi: ExtensionAPI,
	ref: PRReference,
): Promise<{
	pr: PRMetadata;
	prComments: IssueComment[];
	issues: LinkedIssue[];
	reviewers: Reviewer[];
}> {
	const data = await runGraphQL<PRContextResponse>(pi, PR_CONTEXT_QUERY, ref);
	const pr = data.data.repository.pullRequest;

	return {
		pr: parsePRMetadata(pr, ref.number),
		prComments: parsePRComments(pr),
		issues: parseLinkedIssues(pr, ref),
		reviewers: parseReviewers(pr),
	};
}

// Re-export shared diff utilities for backward compatibility
// with crawler.ts and other pr-review consumers.
export { fetchDiff, parseDiff } from "../../lib/github/diff.js";

/** Get the current GitHub username. */
export async function getCurrentUser(pi: ExtensionAPI): Promise<string> {
	const result = await pi.exec("gh", ["api", "user", "--jq", ".login"]);

	if (result.code !== 0) {
		throw new Error(`Failed to get current user: ${result.stderr}`);
	}

	return result.stdout.trim();
}

/**
 * Fetch sibling PRs for the given linked issues.
 * Batches all issue numbers into a single search query.
 */
export async function fetchSiblingPRs(
	pi: ExtensionAPI,
	ref: PRReference,
	issues: LinkedIssue[],
): Promise<RelatedPR[]> {
	if (issues.length === 0) return [];

	const issueTerms = issues.map((i) => String(i.number)).join(" OR ");
	const result = await pi.exec("gh", [
		"api",
		"search/issues",
		"--method",
		"GET",
		"-f",
		`q=repo:${ref.owner}/${ref.repo} is:pr (${issueTerms}) in:body`,
		"--jq",
		".items[] | [.number, .title, .state, .pull_request.html_url] | @tsv",
	]);

	if (result.code !== 0 || !result.stdout.trim()) return [];

	const siblings: RelatedPR[] = [];
	const seen = new Set<number>([ref.number]);

	for (const line of result.stdout.trim().split("\n")) {
		const parts = line.split("\t");
		const prNum = Number.parseInt(parts[0] ?? "", 10);
		if (Number.isNaN(prNum) || seen.has(prNum)) continue;
		seen.add(prNum);

		siblings.push({
			number: prNum,
			title: parts[1] ?? "",
			state: parts[2] ?? "",
			branch: "",
			relationship: "sibling",
			url:
				parts[3] ?? `https://github.com/${ref.owner}/${ref.repo}/pull/${prNum}`,
		});
	}

	return siblings;
}

// Re-export shared review posting.
export { postReview } from "../../lib/github/review-post.js";

/** Extract PR metadata from the GraphQL PR node. */
function parsePRMetadata(pr: GQLPullRequest, prNumber: number): PRMetadata {
	return {
		number: prNumber,
		title: pr.title,
		body: pr.body,
		author: pr.author?.login ?? "unknown",
		headRefName: pr.headRefName,
		baseRefName: pr.baseRefName,
		additions: pr.additions,
		deletions: pr.deletions,
		changedFiles: pr.changedFiles,
		state: pr.state,
	};
}

/** Extract PR comments from the GraphQL PR node. */
function parsePRComments(pr: GQLPullRequest): IssueComment[] {
	return pr.comments.nodes.map((c) => ({
		author: c.author?.login ?? "unknown",
		body: c.body,
		createdAt: c.createdAt,
	}));
}

/** Extract linked issues from the GraphQL PR node. */
function parseLinkedIssues(
	pr: GQLPullRequest,
	ref: PRReference,
): LinkedIssue[] {
	return pr.closingIssuesReferences.nodes.map((issue: GQLIssue) => ({
		number: issue.number,
		title: issue.title,
		body: issue.body,
		state: issue.state,
		labels: issue.labels.nodes.map((l) => l.name),
		comments: issue.comments.nodes.map((c) => ({
			author: c.author?.login ?? "unknown",
			body: c.body,
			createdAt: c.createdAt,
		})),
		parentIssue: null,
		subIssues: [],
		url: `https://github.com/${ref.owner}/${ref.repo}/issues/${issue.number}`,
	}));
}

/** Extract reviewers from review requests and latest reviews. */
function parseReviewers(pr: GQLPullRequest): Reviewer[] {
	const reviewers = new Map<string, Reviewer>();

	// Pending review requests
	for (const req of pr.reviewRequests.nodes) {
		const login = req.requestedReviewer?.login;
		if (login) {
			reviewers.set(login, { login, verdict: "PENDING" });
		}
	}

	// Latest opinionated reviews (overrides pending status)
	for (const review of pr.latestOpinionatedReviews.nodes) {
		const login = review.author?.login;
		if (login) {
			reviewers.set(login, {
				login,
				verdict: review.state as Reviewer["verdict"],
			});
		}
	}

	return [...reviewers.values()];
}

/**
 * GitHub API integration for PR review — fetch PR metadata,
 * diff, linked issues, and related context.
 *
 * Uses GraphQL for structured data and gh CLI for diffs.
 * Response types are defined in types.ts — parsing functions
 * receive typed data, no manual property navigation.
 */

import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type {
	DiffFile,
	DiffHunk,
	DiffLine,
	GatheredContext,
	IssueComment,
	LinkedIssue,
	PRMetadata,
	PreviousReview,
	PreviousThread,
	RelatedPR,
} from "../state.js";
import type { PRReference } from "./parse.js";
import type {
	GQLIssue,
	GQLPullRequest,
	PRContextResponse,
	ReviewsResponse,
} from "./types.js";

// ---- GraphQL queries ----

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
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          path
          line
          comments(first: 50) {
            nodes {
              body
              createdAt
              author { login }
              pullRequestReview { id }
            }
          }
        }
      }
    }
  }
}`;

// ---- Public API ----

/**
 * Fetch PR metadata and linked issues via GraphQL.
 */
export async function fetchPRGraphQL(
	pi: ExtensionAPI,
	ref: PRReference,
): Promise<{
	pr: PRMetadata;
	prComments: IssueComment[];
	issues: LinkedIssue[];
}> {
	const data = await runGraphQL<PRContextResponse>(pi, PR_CONTEXT_QUERY, ref);
	const pr = data.data.repository.pullRequest;

	return {
		pr: parsePRMetadata(pr, ref.number),
		prComments: parsePRComments(pr),
		issues: parseLinkedIssues(pr, ref),
	};
}

/** Assemble a GatheredContext from individually fetched parts. */
export function assembleContext(
	pr: PRMetadata,
	diff: string,
	prComments: IssueComment[],
	issues: LinkedIssue[],
	siblingPRs: RelatedPR[],
): GatheredContext {
	return {
		pr,
		diff,
		diffFiles: parseDiff(diff),
		issues,
		siblingPRs,
		prComments,
	};
}

/** Fetch the unified diff for a PR via gh CLI. */
export async function fetchDiff(
	pi: ExtensionAPI,
	ref: PRReference,
): Promise<string> {
	const result = await pi.exec("gh", [
		"pr",
		"diff",
		String(ref.number),
		"--repo",
		`${ref.owner}/${ref.repo}`,
	]);

	if (result.code !== 0) {
		throw new Error(`Failed to fetch diff: ${result.stderr}`);
	}

	return result.stdout;
}

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

/**
 * Fetch previous reviews by the given user on this PR.
 * Returns reviews and their associated threads.
 */
export async function fetchPreviousReviews(
	pi: ExtensionAPI,
	ref: PRReference,
	username: string,
	prAuthorLogin: string,
): Promise<{
	reviews: PreviousReview[];
	threads: PreviousThread[];
}> {
	const data = await runGraphQL<ReviewsResponse>(pi, REVIEWS_QUERY, ref);
	const { reviews: reviewsNode, reviewThreads } =
		data.data.repository.pullRequest;

	const reviewNodes = reviewsNode.nodes;
	const threadNodes = reviewThreads.nodes;

	// Find reviews by this user
	const userReviews = reviewNodes.filter((r) => r.author?.login === username);
	const userReviewIds = new Set(userReviews.map((r) => r.id));

	const reviews: PreviousReview[] = userReviews.map((r) => {
		const threadCount = threadNodes.filter((t) =>
			t.comments.nodes.some((c) => c.pullRequestReview?.id === r.id),
		).length;

		return {
			id: r.id,
			state: r.state,
			submittedAt: r.submittedAt,
			body: r.body,
			threadCount,
		};
	});

	// Find threads associated with this user's reviews
	const threads: PreviousThread[] = [];
	for (const t of threadNodes) {
		const comments = t.comments.nodes;

		const belongsToUser = comments.some(
			(c) =>
				c.pullRequestReview?.id != null &&
				userReviewIds.has(c.pullRequestReview.id),
		);
		if (!belongsToUser) continue;

		const isResolved = t.isResolved;
		const lastComment = comments[comments.length - 1];
		const lastAuthor = lastComment?.author?.login ?? "unknown";

		let resolvedBy: PreviousThread["resolvedBy"] = null;
		if (isResolved) {
			if (lastAuthor === username) resolvedBy = "self";
			else if (lastAuthor === prAuthorLogin) resolvedBy = "author";
			else resolvedBy = "other";
		}

		threads.push({
			id: t.id,
			file: t.path,
			line: t.line ?? 0,
			body: comments[0]?.body ?? "",
			isResolved,
			resolvedBy,
			comments: comments.map((c) => ({
				author: c.author?.login ?? "unknown",
				body: c.body,
				createdAt: c.createdAt,
			})),
		});
	}

	return { reviews, threads };
}

/** Post a review with comments and verdict to GitHub. */
export async function postReview(
	pi: ExtensionAPI,
	ref: PRReference,
	body: string,
	verdict: string,
	comments: Array<{
		path: string;
		line: number;
		start_line?: number;
		side: string;
		start_side?: string;
		body: string;
	}>,
): Promise<void> {
	const payload = JSON.stringify({ event: verdict, body, comments });

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
			throw new Error(`Failed to post review: ${result.stderr}`);
		}
	} finally {
		try {
			unlinkSync(tmpFile);
		} catch {
			/* Temp file cleanup — safe to ignore */
		}
	}
}

// ---- Parsing helpers ----

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

// ---- Diff parsing ----

/** Parse unified diff output into per-file structures. */
export function parseDiff(diff: string): DiffFile[] {
	const files: DiffFile[] = [];
	const fileSections = diff.split(/^diff --git /m).filter(Boolean);

	for (const section of fileSections) {
		const lines = section.split("\n");
		const headerMatch = lines[0]?.match(/a\/(.+?) b\/(.+)/);
		if (!headerMatch) continue;

		const newPath = headerMatch[2];
		let status: DiffFile["status"] = "modified";
		let additions = 0;
		let deletions = 0;

		if (lines.some((l) => l.startsWith("new file"))) {
			status = "added";
		} else if (lines.some((l) => l.startsWith("deleted file"))) {
			status = "deleted";
		} else if (lines.some((l) => l.startsWith("rename from"))) {
			status = "renamed";
		}

		const hunks: DiffHunk[] = [];
		let currentHunk: DiffHunk | null = null;
		let oldLine = 0;
		let newLine = 0;

		for (const line of lines) {
			const hunkMatch = line.match(
				/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/,
			);
			if (hunkMatch) {
				if (currentHunk) hunks.push(currentHunk);
				const oldStart = Number.parseInt(hunkMatch[1], 10);
				const oldCount = Number.parseInt(hunkMatch[2] ?? "1", 10);
				const newStart = Number.parseInt(hunkMatch[3], 10);
				const newCount = Number.parseInt(hunkMatch[4] ?? "1", 10);
				oldLine = oldStart;
				newLine = newStart;
				currentHunk = {
					header: line,
					oldStart,
					oldCount,
					newStart,
					newCount,
					lines: [],
				};
				continue;
			}

			if (!currentHunk) continue;

			if (line.startsWith("+")) {
				const diffLine: DiffLine = {
					type: "added",
					content: line.slice(1),
					oldLineNumber: null,
					newLineNumber: newLine,
				};
				currentHunk.lines.push(diffLine);
				newLine++;
				additions++;
			} else if (line.startsWith("-")) {
				const diffLine: DiffLine = {
					type: "removed",
					content: line.slice(1),
					oldLineNumber: oldLine,
					newLineNumber: null,
				};
				currentHunk.lines.push(diffLine);
				oldLine++;
				deletions++;
			} else if (line.startsWith(" ") || line === "") {
				const diffLine: DiffLine = {
					type: "context",
					content: line.startsWith(" ") ? line.slice(1) : line,
					oldLineNumber: oldLine,
					newLineNumber: newLine,
				};
				currentHunk.lines.push(diffLine);
				oldLine++;
				newLine++;
			}
		}

		if (currentHunk) hunks.push(currentHunk);

		files.push({ path: newPath, status, hunks, additions, deletions });
	}

	return files;
}

// ---- GraphQL runner ----

/** Execute a typed GraphQL query via gh CLI. */
async function runGraphQL<T>(
	pi: ExtensionAPI,
	query: string,
	ref: PRReference,
): Promise<T> {
	const result = await pi.exec("gh", [
		"api",
		"graphql",
		"-f",
		`query=${query}`,
		"-F",
		`owner=${ref.owner}`,
		"-F",
		`repo=${ref.repo}`,
		"-F",
		`pr=${ref.number}`,
	]);

	if (result.code !== 0) {
		throw new Error(`GitHub GraphQL error: ${result.stderr}`);
	}

	return JSON.parse(result.stdout);
}

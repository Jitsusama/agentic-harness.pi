/**
 * GitHub API integration for PR review — fetch PR metadata,
 * diff, linked issues, and related context.
 *
 * Uses GraphQL for structured data and REST/CLI for diffs.
 */

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

// ---- Public API ----

/**
 * Fetch PR metadata and linked issues via GraphQL.
 * Returns the raw data for further parsing.
 */
export async function fetchPRGraphQL(
	pi: ExtensionAPI,
	ref: PRReference,
): Promise<{
	pr: PRMetadata;
	prComments: IssueComment[];
	issues: LinkedIssue[];
}> {
	const data = await runGraphQL(pi, PR_CONTEXT_QUERY, ref);
	return {
		pr: parsePRMetadata(data, ref.number),
		prComments: parsePRComments(data),
		issues: parseLinkedIssues(data, ref),
	};
}

/**
 * Fetch sibling PRs for the given linked issues.
 */
export { fetchSiblingPRs };

/**
 * Assemble a GatheredContext from individually fetched parts.
 */
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

/**
 * Fetch the unified diff for a PR via gh CLI.
 */
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

/**
 * Get the current GitHub username.
 */
export async function getCurrentUser(pi: ExtensionAPI): Promise<string> {
	const result = await pi.exec("gh", ["api", "user", "--jq", ".login"]);

	if (result.code !== 0) {
		throw new Error(`Failed to get current user: ${result.stderr}`);
	}

	return result.stdout.trim();
}

// ---- Previous reviews (re-review support) ----

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

/**
 * Fetch previous reviews by the given user on this PR.
 * Returns reviews and their associated threads.
 */
export async function fetchPreviousReviews(
	pi: ExtensionAPI,
	ref: PRReference,
	username: string,
): Promise<{
	reviews: PreviousReview[];
	threads: PreviousThread[];
}> {
	const data = await runGraphQL(pi, REVIEWS_QUERY, ref);

	const reviewNodes =
		(nested(data, "data", "repository", "pullRequest", "reviews", "nodes") as
			| Array<Record<string, unknown>>
			| undefined) ?? [];
	const threadNodes =
		(nested(
			data,
			"data",
			"repository",
			"pullRequest",
			"reviewThreads",
			"nodes",
		) as Array<Record<string, unknown>> | undefined) ?? [];

	// Find reviews by this user
	const userReviews = reviewNodes.filter(
		(r) => nested(r, "author", "login") === username,
	);

	const userReviewIds = new Set(userReviews.map((r) => str(r, "id")));

	const reviews: PreviousReview[] = userReviews.map((r) => {
		const reviewId = str(r, "id");
		const threadCount = threadNodes.filter((t) => {
			const comments =
				(nested(t, "comments", "nodes") as
					| Array<Record<string, unknown>>
					| undefined) ?? [];
			return comments.some(
				(c) => nested(c, "pullRequestReview", "id") === reviewId,
			);
		}).length;

		return {
			id: reviewId,
			state: str(r, "state"),
			submittedAt: str(r, "submittedAt"),
			body: str(r, "body"),
			threadCount,
		};
	});

	// Find threads associated with this user's reviews
	const threads: PreviousThread[] = [];
	for (const t of threadNodes) {
		const commentNodes =
			(nested(t, "comments", "nodes") as
				| Array<Record<string, unknown>>
				| undefined) ?? [];

		const belongsToUser = commentNodes.some((c) => {
			const reviewId = nested(c, "pullRequestReview", "id");
			return typeof reviewId === "string" && userReviewIds.has(reviewId);
		});

		if (!belongsToUser) continue;

		const isResolved = t.isResolved === true;
		const lastComment = commentNodes[commentNodes.length - 1];
		const lastAuthor =
			typeof lastComment === "object" && lastComment
				? ((nested(lastComment, "author", "login") as string | undefined) ??
					"unknown")
				: "unknown";

		let resolvedBy: PreviousThread["resolvedBy"] = null;
		if (isResolved) {
			if (lastAuthor === username) resolvedBy = "self";
			else if (
				lastAuthor ===
				(nested(data, "data", "repository", "pullRequest", "author", "login") as
					| string
					| undefined)
			)
				resolvedBy = "author";
			else resolvedBy = "other";
		}

		threads.push({
			id: str(t, "id"),
			file: str(t, "path"),
			line: num(t, "line"),
			body: str(commentNodes[0] ?? {}, "body"),
			isResolved,
			resolvedBy,
			comments: commentNodes.map((c) => ({
				author:
					(nested(c, "author", "login") as string | undefined) ?? "unknown",
				body: str(c, "body"),
				createdAt: str(c, "createdAt"),
			})),
		});
	}

	return { reviews, threads };
}

/**
 * Post a review with comments and verdict to GitHub.
 */
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
	const payload = JSON.stringify({
		event: verdict,
		body,
		comments,
	});

	const { writeFileSync, unlinkSync } = await import("node:fs");
	const { join } = await import("node:path");
	const { tmpdir } = await import("node:os");

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

/** Extract PR metadata from the GraphQL response. */
function parsePRMetadata(
	data: Record<string, unknown>,
	prNumber: number,
): PRMetadata {
	const pr = nested(data, "data", "repository", "pullRequest") ?? {};
	return {
		number: prNumber,
		title: str(pr, "title"),
		body: str(pr, "body"),
		author: nested(pr, "author", "login") ?? "unknown",
		headRefName: str(pr, "headRefName"),
		baseRefName: str(pr, "baseRefName"),
		additions: num(pr, "additions"),
		deletions: num(pr, "deletions"),
		changedFiles: num(pr, "changedFiles"),
		state: str(pr, "state"),
	};
}

/** Extract PR comments from the GraphQL response. */
function parsePRComments(data: Record<string, unknown>): IssueComment[] {
	const nodes =
		(nested(data, "data", "repository", "pullRequest", "comments", "nodes") as
			| Array<Record<string, unknown>>
			| undefined) ?? [];

	return nodes.map((c) => ({
		author: nested(c, "author", "login") ?? "unknown",
		body: str(c, "body"),
		createdAt: str(c, "createdAt"),
	}));
}

/** Extract linked issues from the GraphQL response. */
function parseLinkedIssues(
	data: Record<string, unknown>,
	ref: PRReference,
): LinkedIssue[] {
	const nodes =
		(nested(
			data,
			"data",
			"repository",
			"pullRequest",
			"closingIssuesReferences",
			"nodes",
		) as Array<Record<string, unknown>> | undefined) ?? [];

	return nodes.map((issue) => {
		const labelNodes =
			(nested(issue, "labels", "nodes") as
				| Array<Record<string, unknown>>
				| undefined) ?? [];
		const commentNodes =
			(nested(issue, "comments", "nodes") as
				| Array<Record<string, unknown>>
				| undefined) ?? [];

		return {
			number: num(issue, "number"),
			title: str(issue, "title"),
			body: str(issue, "body"),
			state: str(issue, "state"),
			labels: labelNodes.map((l) => str(l, "name")),
			comments: commentNodes.map((c) => ({
				author: nested(c, "author", "login") ?? "unknown",
				body: str(c, "body"),
				createdAt: str(c, "createdAt"),
			})),
			parentIssue: null,
			subIssues: [],
			url: `https://github.com/${ref.owner}/${ref.repo}/issues/${num(issue, "number")}`,
		};
	});
}

/** Fetch PRs that reference the same issues (sibling PRs). */
async function fetchSiblingPRs(
	pi: ExtensionAPI,
	ref: PRReference,
	issues: LinkedIssue[],
): Promise<RelatedPR[]> {
	const siblings: RelatedPR[] = [];
	const seen = new Set<number>([ref.number]);

	for (const issue of issues) {
		const result = await pi.exec("gh", [
			"api",
			"search/issues",
			"--method",
			"GET",
			"-f",
			`q=repo:${ref.owner}/${ref.repo} is:pr ${issue.number} in:body`,
			"--jq",
			".items[] | [.number, .title, .state, .pull_request.html_url] | @tsv",
		]);

		if (result.code !== 0 || !result.stdout.trim()) continue;

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
					parts[3] ??
					`https://github.com/${ref.owner}/${ref.repo}/pull/${prNum}`,
			});
		}
	}

	return siblings;
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

		// Detect file status from diff headers
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

		files.push({
			path: newPath,
			status,
			hunks,
			additions,
			deletions,
		});
	}

	return files;
}

// ---- GraphQL runner ----

/** Execute a GraphQL query via gh CLI. */
async function runGraphQL(
	pi: ExtensionAPI,
	query: string,
	ref: PRReference,
): Promise<Record<string, unknown>> {
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

// ---- Safe property access ----

/** Safely navigate nested objects. */
function nested(obj: unknown, ...keys: string[]): unknown {
	let current = obj;
	for (const key of keys) {
		if (current == null || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[key];
	}
	return current;
}

/** Safely extract a string property. */
function str(obj: unknown, key: string): string {
	if (obj == null || typeof obj !== "object") return "";
	const val = (obj as Record<string, unknown>)[key];
	return typeof val === "string" ? val : "";
}

/** Safely extract a number property. */
function num(obj: unknown, key: string): number {
	if (obj == null || typeof obj !== "object") return 0;
	const val = (obj as Record<string, unknown>)[key];
	return typeof val === "number" ? val : 0;
}

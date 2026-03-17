/**
 * Deep context crawler — recursive link crawler that follows
 * references up to 5 levels deep with loop detection.
 *
 * Crawl levels:
 *   0: PR itself (metadata, diff, comments, reviewers, linked issues)
 *   1: Linked issues (body, comments, parent/sub-issues, sibling PRs)
 *   2–4: References discovered at previous levels
 *   5: Stop — set hitDepthLimit if references remain unfollowed
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	fetchDiff,
	fetchPRGraphQL,
	fetchSiblingPRs,
	parseDiff,
} from "./api/github.js";
import type { PRReference } from "./api/parse.js";
import type { GQLDeepIssue, IssueDeepResponse } from "./api/types.js";
import type {
	CrawlResult,
	DiffFile,
	LinkedIssue,
	Reference,
	RelatedPR,
	SourceFile,
} from "./state.js";

/** Default maximum crawl depth. */
const DEFAULT_MAX_DEPTH = 5;

/** Maximum characters to scan for link extraction per body. */
const MAX_BODY_SCAN = 10000;

// ---- GraphQL ----

const ISSUE_DEEP_QUERY = `
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      number title body state
      labels(first: 10) { nodes { name } }
      comments(first: 30) {
        nodes { author { login } body createdAt }
      }
      trackedInIssues(first: 10) {
        nodes { number title state body }
      }
      trackedIssues(first: 20) {
        nodes { number title state body }
      }
      timelineItems(first: 50, itemTypes: [CROSS_REFERENCED_EVENT]) {
        nodes {
          ... on CrossReferencedEvent {
            source {
              __typename
              ... on Issue { number title state url }
              ... on PullRequest { number title state url }
            }
          }
        }
      }
    }
  }
}`;

// ---- Public API ----

/** Crawl configuration. */
export interface CrawlConfig {
	maxDepth: number;
	visited: Set<string>;
}

/** Progress callback — called as crawl depth advances. */
export type CrawlProgress = (depth: number, label: string) => void;

/**
 * Crawl deep context for a PR. Returns a fully populated
 * CrawlResult with all discovered references, issues,
 * source files, and reviewers.
 */
export async function crawl(
	pi: ExtensionAPI,
	ref: PRReference,
	repoPath: string,
	onProgress?: CrawlProgress,
): Promise<CrawlResult> {
	const config: CrawlConfig = {
		maxDepth: DEFAULT_MAX_DEPTH,
		visited: new Set(),
	};

	const references: Reference[] = [];
	const issues: LinkedIssue[] = [];
	const relatedPRs: RelatedPR[] = [];
	let hitDepthLimit = false;

	// ---- Level 0: PR itself ----
	onProgress?.(0, "Fetching PR metadata & issues");
	config.visited.add(`pr:${ref.owner}/${ref.repo}#${ref.number}`);

	const [graphqlData, diff] = await Promise.all([
		fetchPRGraphQL(pi, ref),
		fetchDiff(pi, ref),
	]);

	const { pr, prComments, issues: linkedIssues, reviewers } = graphqlData;
	const diffFiles = parseDiff(diff);

	issues.push(...linkedIssues);
	for (const issue of linkedIssues) {
		config.visited.add(`issue:${ref.owner}/${ref.repo}#${issue.number}`);
	}

	// Extract references from PR body and comments
	const prBodyRefs = extractReferences(pr.body, ref, "PR body", 0);
	const prCommentRefs = prComments.flatMap((c) =>
		extractReferences(c.body, ref, `PR comment by @${c.author}`, 0),
	);
	addNewReferences(references, [...prBodyRefs, ...prCommentRefs], config);

	// ---- Level 1: Linked issues ----
	onProgress?.(1, "Crawling linked issues");

	const siblingPRs = await fetchSiblingPRs(pi, ref, linkedIssues);
	relatedPRs.push(...siblingPRs);
	for (const sibling of siblingPRs) {
		config.visited.add(`pr:${ref.owner}/${ref.repo}#${sibling.number}`);
		references.push({
			type: "pr",
			url: sibling.url,
			title: `#${sibling.number}: ${sibling.title}`,
			description: `Sibling PR (${sibling.state})`,
			depth: 1,
			source: "linked issues",
		});
	}

	for (const issue of linkedIssues) {
		await crawlIssueDeeply(pi, ref, issue, config, references, issues, 1);
	}

	// ---- Levels 2–maxDepth: Follow discovered references ----
	for (let depth = 2; depth <= config.maxDepth; depth++) {
		const pendingRefs = references.filter(
			(r) =>
				r.depth === depth - 1 &&
				(r.type === "issue" || r.type === "pr") &&
				!config.visited.has(refKey(r)),
		);

		if (pendingRefs.length === 0) break;

		if (depth === config.maxDepth) {
			hitDepthLimit = true;
			break;
		}

		onProgress?.(
			depth,
			`Crawling linked references (depth ${depth}/${config.maxDepth})`,
		);

		for (const pendingRef of pendingRefs) {
			const parsed = parseRefUrl(pendingRef.url, ref);
			if (!parsed) continue;

			if (pendingRef.type === "issue") {
				await crawlIssueReference(
					pi,
					parsed,
					pendingRef,
					config,
					references,
					depth,
				);
			}
			// PR references at depth 2+ — just record them, don't deep-crawl
			config.visited.add(refKey(pendingRef));
		}
	}

	// ---- Enrich references with known issue/PR titles ----
	enrichReferences(references, issues, relatedPRs);

	// ---- Source file discovery ----
	onProgress?.(config.maxDepth, "Discovering source files");
	const sourceFiles = await discoverSourceFiles(pi, ref, diffFiles, repoPath);

	return {
		pr,
		diff,
		diffFiles,
		issues,
		relatedPRs,
		references,
		sourceFiles,
		reviewers,
		prComments,
		hitDepthLimit,
	};
}

// ---- Deep issue crawling ----

/**
 * Crawl a linked issue deeply — fetch parent/sub-issues and
 * extract references from its body and comments.
 */
async function crawlIssueDeeply(
	pi: ExtensionAPI,
	ref: PRReference,
	issue: LinkedIssue,
	config: CrawlConfig,
	references: Reference[],
	_issues: LinkedIssue[],
	depth: number,
): Promise<void> {
	try {
		const data = await fetchDeepIssue(pi, ref, issue.number);
		if (!data) return;

		// Parent issues
		for (const parent of data.trackedInIssues.nodes) {
			const key = `issue:${ref.owner}/${ref.repo}#${parent.number}`;
			if (config.visited.has(key)) continue;
			config.visited.add(key);

			issue.parentIssue = {
				number: parent.number,
				title: parent.title,
				body: parent.body,
			};

			references.push({
				type: "issue",
				url: `https://github.com/${ref.owner}/${ref.repo}/issues/${parent.number}`,
				title: `#${parent.number}: ${parent.title}`,
				description: "Parent issue",
				depth,
				source: `Issue #${issue.number}`,
			});
		}

		// Sub-issues
		for (const sub of data.trackedIssues.nodes) {
			const key = `issue:${ref.owner}/${ref.repo}#${sub.number}`;
			if (config.visited.has(key)) continue;
			config.visited.add(key);

			issue.subIssues.push({
				number: sub.number,
				title: sub.title,
				state: sub.state,
			});

			references.push({
				type: "issue",
				url: `https://github.com/${ref.owner}/${ref.repo}/issues/${sub.number}`,
				title: `#${sub.number}: ${sub.title}`,
				description: `Sub-issue (${sub.state})`,
				depth,
				source: `Issue #${issue.number}`,
			});
		}

		// Cross-references from timeline
		for (const xref of data.timelineItems.nodes) {
			if (!xref.source?.number || !xref.source.url) continue;

			const type = xref.source.__typename === "PullRequest" ? "pr" : "issue";
			const key = `${type}:${ref.owner}/${ref.repo}#${xref.source.number}`;
			if (config.visited.has(key)) continue;
			config.visited.add(key);

			references.push({
				type: type as Reference["type"],
				url: xref.source.url,
				title: `#${xref.source.number}: ${xref.source.title ?? ""}`,
				description: `Cross-referenced ${type} (${xref.source.state ?? "unknown"})`,
				depth,
				source: `Issue #${issue.number}`,
			});
		}

		// Extract references from issue body and comments
		const bodyRefs = extractReferences(
			data.body,
			ref,
			`Issue #${issue.number} body`,
			depth,
		);
		const commentRefs = data.comments.nodes.flatMap((c) =>
			extractReferences(c.body, ref, `Issue #${issue.number} comment`, depth),
		);
		addNewReferences(references, [...bodyRefs, ...commentRefs], config);
	} catch {
		/* Issue fetch failed — not fatal, continue crawling */
	}
}

/**
 * Crawl an issue reference discovered at depth 2+.
 * Lighter than deep crawling — just fetches metadata and extracts refs.
 */
async function crawlIssueReference(
	pi: ExtensionAPI,
	parsed: { owner: string; repo: string; number: number },
	pendingRef: Reference,
	config: CrawlConfig,
	references: Reference[],
	depth: number,
): Promise<void> {
	config.visited.add(refKey(pendingRef));

	try {
		const data = await fetchDeepIssue(pi, parsed, parsed.number);
		if (!data) return;

		// Update the reference with real title
		pendingRef.title = `#${data.number}: ${data.title}`;
		pendingRef.description =
			data.body.slice(0, 200) + (data.body.length > 200 ? "…" : "");

		// Extract references from body
		const bodyRefs = extractReferences(
			data.body,
			parsed,
			`Issue #${data.number} body`,
			depth,
		);
		addNewReferences(references, bodyRefs, config);
	} catch {
		/* Reference fetch failed — not fatal */
	}
}

// ---- Link extraction ----

/** GitHub reference patterns in markdown text. */
const HASH_REF_PATTERN = /(?:^|[^/\w])(?:(\w[\w.-]*\/\w[\w.-]*))?#(\d+)/g;
const GITHUB_URL_PATTERN =
	/https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(issues|pull|commit)\/([\w]+)/g;
const EXTERNAL_URL_PATTERN = /https?:\/\/[^\s<>\])]+/g;

/** Extract GitHub-style references from text. */
function extractReferences(
	text: string,
	defaultRef: { owner: string; repo: string },
	source: string,
	depth: number,
): Reference[] {
	if (!text) return [];

	const scanText = text.slice(0, MAX_BODY_SCAN);
	const refs: Reference[] = [];
	const seen = new Set<string>();

	// #123 and owner/repo#123
	for (const match of scanText.matchAll(HASH_REF_PATTERN)) {
		const repoRef = match[1];
		const num = match[2];
		const owner = repoRef ? repoRef.split("/")[0] : defaultRef.owner;
		const repo = repoRef ? repoRef.split("/")[1] : defaultRef.repo;
		const url = `https://github.com/${owner}/${repo}/issues/${num}`;
		const key = `${owner}/${repo}#${num}`;

		if (seen.has(key)) continue;
		seen.add(key);

		refs.push({
			type: "issue",
			url,
			title: `#${num}`,
			description: "",
			depth,
			source,
		});
	}

	// Full GitHub URLs
	for (const match of scanText.matchAll(GITHUB_URL_PATTERN)) {
		const owner = match[1];
		const repo = match[2];
		const kind = match[3];
		const id = match[4];
		const url = match[0];
		const key = `${owner}/${repo}/${kind}/${id}`;

		if (seen.has(key)) continue;
		seen.add(key);

		let type: Reference["type"] = "external";
		if (kind === "issues") type = "issue";
		else if (kind === "pull") type = "pr";
		else if (kind === "commit") type = "commit";

		refs.push({
			type,
			url,
			title: type === "commit" ? `${id.slice(0, 7)}` : `#${id}`,
			description: "",
			depth,
			source,
		});
	}

	// Other URLs — stored as external references
	for (const match of scanText.matchAll(EXTERNAL_URL_PATTERN)) {
		const url = match[0];
		if (url.includes("github.com") && seen.has(url)) continue;
		if (seen.has(url)) continue;
		seen.add(url);

		// Skip GitHub URLs already captured above
		if (GITHUB_URL_PATTERN.test(url)) continue;

		refs.push({
			type: "external",
			url,
			title: truncateUrl(url),
			description: "",
			depth,
			source,
		});
	}

	return refs;
}

/**
 * Enrich references with titles and descriptions from already-fetched
 * issues and related PRs. Fixes bare "#123" titles from text extraction.
 */
function enrichReferences(
	references: Reference[],
	issues: LinkedIssue[],
	relatedPRs: RelatedPR[],
): void {
	const issueTitles = new Map<number, { title: string; body: string }>();
	for (const issue of issues) {
		issueTitles.set(issue.number, { title: issue.title, body: issue.body });
		if (issue.parentIssue) {
			issueTitles.set(issue.parentIssue.number, {
				title: issue.parentIssue.title,
				body: issue.parentIssue.body,
			});
		}
		for (const sub of issue.subIssues) {
			issueTitles.set(sub.number, { title: sub.title, body: "" });
		}
	}

	const prTitles = new Map<number, string>();
	for (const pr of relatedPRs) {
		prTitles.set(pr.number, pr.title);
	}

	for (const ref of references) {
		const num = extractRefNumber(ref.url);
		if (num === null) continue;

		if (ref.type === "issue" && issueTitles.has(num)) {
			const data = issueTitles.get(num);
			if (data && ref.title === `#${num}`) {
				ref.title = `#${num}: ${data.title}`;
			}
			if (data && !ref.description && data.body) {
				ref.description =
					data.body.slice(0, 200) + (data.body.length > 200 ? "…" : "");
			}
		}

		if (ref.type === "pr" && prTitles.has(num)) {
			const title = prTitles.get(num);
			if (title && ref.title === `#${num}`) {
				ref.title = `#${num}: ${title}`;
			}
		}
	}
}

/** Extract issue/PR number from a reference URL. */
function extractRefNumber(url: string): number | null {
	const match = url.match(/\/(\d+)\/?$/);
	return match ? Number.parseInt(match[1], 10) : null;
}

/** Add new references, skipping those already visited. */
function addNewReferences(
	all: Reference[],
	newRefs: Reference[],
	config: CrawlConfig,
): void {
	for (const r of newRefs) {
		const key = refKey(r);
		if (config.visited.has(key)) continue;
		all.push(r);
	}
}

/** Build a dedup key for a reference. */
function refKey(r: Reference): string {
	if (r.type === "external") return r.url;
	return `${r.type}:${r.url}`;
}

/** Parse a reference URL back into owner/repo/number. */
function parseRefUrl(
	url: string,
	defaultRef: { owner: string; repo: string },
): { owner: string; repo: string; number: number } | null {
	const match = url.match(
		/github\.com\/([\w.-]+)\/([\w.-]+)\/(issues|pull)\/(\d+)/,
	);
	if (match) {
		return {
			owner: match[1],
			repo: match[2],
			number: Number.parseInt(match[4], 10),
		};
	}

	// Hash reference in title
	const hashMatch = url.match(/#(\d+)$/);
	if (hashMatch) {
		return {
			owner: defaultRef.owner,
			repo: defaultRef.repo,
			number: Number.parseInt(hashMatch[1], 10),
		};
	}

	return null;
}

/** Truncate a URL for display. */
function truncateUrl(url: string): string {
	const maxLen = 60;
	if (url.length <= maxLen) return url;
	return `${url.slice(0, maxLen)}…`;
}

// ---- Source file discovery ----

/**
 * Discover key source files the PR interacts with.
 *
 * Only includes files changed in the diff. Reverse import and
 * test file discovery was removed because basename-based rg
 * searches produce too many false positives in large repos
 * (e.g., searching for "table" matches hundreds of files).
 * The agent can use rg/read to investigate further.
 */
async function discoverSourceFiles(
	_pi: ExtensionAPI,
	ref: PRReference,
	diffFiles: DiffFile[],
	_repoPath: string,
): Promise<SourceFile[]> {
	const baseUrl = `https://github.com/${ref.owner}/${ref.repo}/blob/HEAD`;

	return diffFiles.map((file) => ({
		path: file.path,
		role: "",
		url: `${baseUrl}/${file.path}`,
	}));
}

// ---- Issue fetching ----

/** Fetch a deep issue via GraphQL. */
async function fetchDeepIssue(
	pi: ExtensionAPI,
	ref: { owner: string; repo: string },
	issueNumber: number,
): Promise<GQLDeepIssue | null> {
	try {
		const result = await pi.exec("gh", [
			"api",
			"graphql",
			"-f",
			`query=${ISSUE_DEEP_QUERY}`,
			"-F",
			`owner=${ref.owner}`,
			"-F",
			`repo=${ref.repo}`,
			"-F",
			`number=${issueNumber}`,
		]);

		if (result.code !== 0) return null;

		const data = JSON.parse(result.stdout) as IssueDeepResponse;
		return data.data.repository.issue;
	} catch {
		/* Issue fetch failed — not fatal */
		return null;
	}
}

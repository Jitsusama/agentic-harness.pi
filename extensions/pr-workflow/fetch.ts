/**
 * Fetch and parse pull request metadata from GitHub.
 *
 * The wire boundary lives in two halves: `parsePrMetadata`
 * turns a raw GraphQL response into the typed shape the rest
 * of the workflow consumes, and `fetchPrMetadata` orchestrates
 * the round trip via the shared `runGraphQL` runner. Splitting
 * them this way keeps the parser pure and testable without
 * stubbing out a process boundary.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { runGraphQL } from "../../lib/internal/github/graphql.js";
import type { PRReference } from "../../lib/internal/github/pr-reference.js";

/** PR lifecycle states GitHub returns over GraphQL. */
export type PrState = "OPEN" | "CLOSED" | "MERGED";

/** Subset of PR metadata the workflow consumes. */
export interface PrMetadata {
	readonly title: string;
	/** Login of the author. `"ghost"` for deleted accounts. */
	readonly author: string;
	readonly state: PrState;
	readonly isDraft: boolean;
	readonly url: string;
	readonly body: string;
	readonly base: { ref: string; sha: string };
	readonly head: { ref: string; sha: string };
	readonly additions: number;
	readonly deletions: number;
	readonly changedFiles: number;
	readonly createdAt: string;
	readonly updatedAt: string;
}

const PR_QUERY = `query PrMetadata($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      title
      author { login }
      state
      isDraft
      url
      body
      baseRefName
      baseRefOid
      headRefName
      headRefOid
      additions
      deletions
      changedFiles
      createdAt
      updatedAt
    }
  }
}`;

const VALID_STATES: ReadonlySet<string> = new Set(["OPEN", "CLOSED", "MERGED"]);

/**
 * Parse a raw GraphQL response into typed metadata.
 *
 * Throws if the response shape is unexpected. The caller is
 * responsible for catching and surfacing a useful message.
 */
export function parsePrMetadata(raw: unknown): PrMetadata {
	if (!isRecord(raw)) {
		throw new Error("PR metadata response was not an object");
	}
	const data = raw.data;
	if (!isRecord(data)) {
		throw new Error("PR metadata response is missing `data`");
	}
	const repository = data.repository;
	if (!isRecord(repository)) {
		throw new Error("PR metadata response: pull request not found");
	}
	const pr = repository.pullRequest;
	if (!isRecord(pr)) {
		throw new Error("PR metadata response: pull request not found");
	}

	const state = expectString(pr, "state");
	if (!VALID_STATES.has(state)) {
		throw new Error(`PR metadata: unexpected state "${state}"`);
	}

	const author = pr.author;
	const authorLogin =
		author === null || author === undefined
			? "ghost"
			: isRecord(author)
				? expectString(author, "login")
				: (() => {
						throw new Error("PR metadata: `author` has unexpected shape");
					})();

	return {
		title: expectString(pr, "title"),
		author: authorLogin,
		state: state as PrState,
		isDraft: expectBoolean(pr, "isDraft"),
		url: expectString(pr, "url"),
		body: expectString(pr, "body"),
		base: {
			ref: expectString(pr, "baseRefName"),
			sha: expectString(pr, "baseRefOid"),
		},
		head: {
			ref: expectString(pr, "headRefName"),
			sha: expectString(pr, "headRefOid"),
		},
		additions: expectNumber(pr, "additions"),
		deletions: expectNumber(pr, "deletions"),
		changedFiles: expectNumber(pr, "changedFiles"),
		createdAt: expectString(pr, "createdAt"),
		updatedAt: expectString(pr, "updatedAt"),
	};
}

/** Round-trip a PR metadata request through `gh api graphql`. */
export async function fetchPrMetadata(
	pi: ExtensionAPI,
	reference: PRReference,
): Promise<PrMetadata> {
	const raw = await runGraphQL<unknown>(pi, PR_QUERY, {
		owner: reference.owner,
		repo: reference.repo,
		number: reference.number,
	});
	return parsePrMetadata(raw);
}

/**
 * Fetch a file's contents at a specific ref via `gh api`.
 *
 * Uses the contents endpoint, which returns base64-encoded
 * file data up to 1 MB. Larger files require a different
 * code path (blobs API) that lands when the workflow has a
 * reason to view them.
 */
export async function fetchFileContent(
	pi: ExtensionAPI,
	owner: string,
	repo: string,
	ref: string,
	path: string,
): Promise<string> {
	const result = await pi.exec("gh", [
		"api",
		`/repos/${owner}/${repo}/contents/${path}?ref=${ref}`,
		"--jq",
		".content",
	]);
	if (result.code !== 0) {
		throw new Error(
			`Failed to fetch ${path} at ${ref}: ${result.stderr.trim() || "non-zero exit"}`,
		);
	}
	const base64 = result.stdout.replace(/\s+/g, "");
	if (!base64) {
		throw new Error(`No content returned for ${path} at ${ref}`);
	}
	return Buffer.from(base64, "base64").toString("utf-8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectString(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	if (typeof value !== "string") {
		throw new Error(`PR metadata: \`${key}\` is not a string`);
	}
	return value;
}

function expectNumber(record: Record<string, unknown>, key: string): number {
	const value = record[key];
	if (typeof value !== "number") {
		throw new Error(`PR metadata: \`${key}\` is not a number`);
	}
	return value;
}

function expectBoolean(record: Record<string, unknown>, key: string): boolean {
	const value = record[key];
	if (typeof value !== "boolean") {
		throw new Error(`PR metadata: \`${key}\` is not a boolean`);
	}
	return value;
}

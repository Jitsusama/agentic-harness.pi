import { describe, expect, it } from "vitest";
import { parsePrMetadata } from "../../../extensions/pr-workflow/fetch.js";

/**
 * Builds a minimal-but-valid GraphQL response envelope for
 * the `pr-workflow` PR query. Tests override individual
 * fields by mutating the returned object.
 */
function validResponse(): {
	data: {
		repository: {
			pullRequest: {
				title: string;
				author: { login: string } | null;
				state: string;
				isDraft: boolean;
				url: string;
				body: string;
				baseRefName: string;
				baseRefOid: string;
				headRefName: string;
				headRefOid: string;
				additions: number;
				deletions: number;
				changedFiles: number;
				createdAt: string;
				updatedAt: string;
			};
		};
	};
} {
	return {
		data: {
			repository: {
				pullRequest: {
					title: "Add the thing",
					author: { login: "octocat" },
					state: "OPEN",
					isDraft: false,
					url: "https://github.com/owner/repo/pull/7",
					body: "## Description\n\nDoes the thing.",
					baseRefName: "main",
					baseRefOid: "0123456789abcdef",
					headRefName: "feature/the-thing",
					headRefOid: "fedcba9876543210",
					additions: 42,
					deletions: 7,
					changedFiles: 3,
					createdAt: "2026-05-17T12:00:00Z",
					updatedAt: "2026-05-18T01:00:00Z",
				},
			},
		},
	};
}

describe("parsePrMetadata", () => {
	it("extracts the fields the workflow needs from a happy response", () => {
		// The parser is the contract between the GraphQL wire
		// format and the rest of the workflow. Pinning every
		// field protects downstream code from upstream surprises.
		const metadata = parsePrMetadata(validResponse());
		expect(metadata).toEqual({
			title: "Add the thing",
			author: "octocat",
			state: "OPEN",
			isDraft: false,
			url: "https://github.com/owner/repo/pull/7",
			body: "## Description\n\nDoes the thing.",
			base: { ref: "main", sha: "0123456789abcdef" },
			head: { ref: "feature/the-thing", sha: "fedcba9876543210" },
			additions: 42,
			deletions: 7,
			changedFiles: 3,
			createdAt: "2026-05-17T12:00:00Z",
			updatedAt: "2026-05-18T01:00:00Z",
		});
	});

	it("treats a null author as the GitHub ghost user", () => {
		// Deleted accounts return author=null on GraphQL. We map
		// that to "ghost" so downstream code can render a string
		// unconditionally.
		const raw = validResponse();
		raw.data.repository.pullRequest.author = null;
		const metadata = parsePrMetadata(raw);
		expect(metadata.author).toBe("ghost");
	});

	it("preserves bot authors verbatim", () => {
		// Bot logins look like `github-actions[bot]`. We don't
		// strip the suffix; downstream code may want to colour-code
		// bot rows differently.
		const raw = validResponse();
		raw.data.repository.pullRequest.author = {
			login: "github-actions[bot]",
		};
		const metadata = parsePrMetadata(raw);
		expect(metadata.author).toBe("github-actions[bot]");
	});

	it("preserves the draft flag", () => {
		// Drafts skip post gates; the workflow needs to know.
		const raw = validResponse();
		raw.data.repository.pullRequest.isDraft = true;
		const metadata = parsePrMetadata(raw);
		expect(metadata.isDraft).toBe(true);
	});

	it.each([
		"OPEN",
		"CLOSED",
		"MERGED",
	] as const)("passes the %s state through", (state) => {
		// The three GitHub PR states are surfaced as-is; the
		// workflow decides what to do with each.
		const raw = validResponse();
		raw.data.repository.pullRequest.state = state;
		const metadata = parsePrMetadata(raw);
		expect(metadata.state).toBe(state);
	});

	it("rejects an unknown state", () => {
		// If GitHub ever introduces a new state, the parser should
		// fail loudly rather than smuggle an unknown enum value
		// into the rest of the workflow.
		const raw = validResponse();
		raw.data.repository.pullRequest.state = "DRAFT";
		expect(() => parsePrMetadata(raw)).toThrow(/state/i);
	});

	it("throws when the response envelope is missing", () => {
		// A `gh api` 404 still returns 200 from the GraphQL
		// endpoint but with `data.repository.pullRequest === null`.
		// Surface that as a parse error so the caller can show a
		// useful message.
		expect(() => parsePrMetadata({ data: { repository: null } })).toThrow(
			/pull request/i,
		);
		expect(() =>
			parsePrMetadata({ data: { repository: { pullRequest: null } } }),
		).toThrow(/pull request/i);
	});

	it("throws when given a totally unexpected shape", () => {
		// Garbage input must throw; the workflow won't silently
		// fabricate metadata.
		expect(() => parsePrMetadata({})).toThrow();
		expect(() => parsePrMetadata(null)).toThrow();
		expect(() => parsePrMetadata("nope")).toThrow();
	});

	it("throws when a required field has the wrong type", () => {
		// Defensive parsing: a string where we expect a number is
		// not silently coerced.
		const raw = validResponse();
		(
			raw.data.repository.pullRequest as unknown as { additions: string }
		).additions = "lots";
		expect(() => parsePrMetadata(raw)).toThrow();
	});
});

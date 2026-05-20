import { describe, expect, it } from "vitest";
import { parseReviewThreads } from "../../../extensions/pr-workflow/threads.js";

/**
 * Builds a minimal-but-valid GraphQL response envelope for
 * the `pr-workflow` review-threads query. Tests override
 * individual fields by mutating the returned object.
 */
function validResponse(): {
	data: {
		repository: {
			pullRequest: {
				reviewThreads: {
					nodes: Array<{
						id: string;
						isResolved: boolean;
						isOutdated: boolean;
						path: string | null;
						line: number | null;
						comments: {
							nodes: Array<{
								id: string;
								author: { login: string } | null;
								body: string;
								createdAt: string;
								url: string;
							}>;
						};
					}>;
				};
				comments: {
					nodes: Array<{
						id: string;
						author: { login: string } | null;
						body: string;
						createdAt: string;
						url: string;
					}>;
				};
			};
		};
	};
} {
	return {
		data: {
			repository: {
				pullRequest: {
					reviewThreads: {
						nodes: [
							{
								id: "T1",
								isResolved: false,
								isOutdated: false,
								path: "src/foo.ts",
								line: 12,
								comments: {
									nodes: [
										{
											id: "C1",
											author: { login: "octocat" },
											body: "Could this be simpler?",
											createdAt: "2024-01-01T00:00:00Z",
											url: "https://github.com/o/r/pull/1#discussion_r1",
										},
									],
								},
							},
						],
					},
					comments: { nodes: [] },
				},
			},
		},
	};
}

describe("parseReviewThreads", () => {
	it("returns one thread per node with comments preserved in order", () => {
		const raw = validResponse();
		raw.data.repository.pullRequest.reviewThreads.nodes[0].comments.nodes.push({
			id: "C2",
			author: { login: "reviewer2" },
			body: "Agreed.",
			createdAt: "2024-01-02T00:00:00Z",
			url: "https://github.com/o/r/pull/1#discussion_r2",
		});
		const parsed = parseReviewThreads(raw);
		expect(parsed).toHaveLength(1);
		expect(parsed[0].id).toBe("T1");
		expect(parsed[0].kind).toBe("review-thread");
		expect(parsed[0].comments).toHaveLength(2);
		expect(parsed[0].comments.map((c) => c.id)).toEqual(["C1", "C2"]);
	});

	it("propagates isResolved, isOutdated, path, and line", () => {
		const raw = validResponse();
		raw.data.repository.pullRequest.reviewThreads.nodes[0].isResolved = true;
		raw.data.repository.pullRequest.reviewThreads.nodes[0].isOutdated = true;
		const parsed = parseReviewThreads(raw);
		expect(parsed[0].isResolved).toBe(true);
		expect(parsed[0].isOutdated).toBe(true);
		expect(parsed[0].path).toBe("src/foo.ts");
		expect(parsed[0].line).toBe(12);
	});

	it("treats deleted comment authors as 'ghost'", () => {
		const raw = validResponse();
		raw.data.repository.pullRequest.reviewThreads.nodes[0].comments.nodes[0].author =
			null;
		const parsed = parseReviewThreads(raw);
		expect(parsed[0].comments[0].author).toBe("ghost");
	});

	it("accepts threads without a path or line (PR-level threads)", () => {
		const raw = validResponse();
		raw.data.repository.pullRequest.reviewThreads.nodes[0].path = null;
		raw.data.repository.pullRequest.reviewThreads.nodes[0].line = null;
		const parsed = parseReviewThreads(raw);
		expect(parsed[0].path).toBeNull();
		expect(parsed[0].line).toBeNull();
	});

	it("returns an empty list when the PR has no threads or review-level comments", () => {
		const raw = validResponse();
		raw.data.repository.pullRequest.reviewThreads.nodes = [];
		raw.data.repository.pullRequest.comments.nodes = [];
		expect(parseReviewThreads(raw)).toEqual([]);
	});

	it("merges PR review-level comments after inline review threads", () => {
		const raw = validResponse();
		raw.data.repository.pullRequest.comments.nodes.push({
			id: "IC1",
			author: { login: "maintainer" },
			body: "Thanks for the detailed review.",
			createdAt: "2024-01-03T00:00:00Z",
			url: "https://github.com/o/r/pull/1#issuecomment-1",
		});

		const parsed = parseReviewThreads(raw);

		expect(parsed).toHaveLength(2);
		expect(parsed[0].kind).toBe("review-thread");
		expect(parsed[1]).toMatchObject({
			id: "IC1",
			kind: "review-level",
			isResolved: false,
			isOutdated: false,
			path: null,
			line: null,
		});
		expect(parsed[1].comments).toEqual([
			{
				id: "IC1",
				author: "maintainer",
				body: "Thanks for the detailed review.",
				createdAt: "2024-01-03T00:00:00Z",
				url: "https://github.com/o/r/pull/1#issuecomment-1",
			},
		]);
	});

	it("throws when the PR is not found", () => {
		const raw = {
			data: { repository: { pullRequest: null } },
		};
		expect(() => parseReviewThreads(raw)).toThrow(/not found/i);
	});

	it("throws when a thread is missing its id", () => {
		const raw = validResponse();
		// biome-ignore lint/suspicious/noExplicitAny: deliberate shape break for test
		(raw.data.repository.pullRequest.reviewThreads.nodes[0] as any).id =
			undefined;
		expect(() => parseReviewThreads(raw)).toThrow();
	});
});

import { describe, expect, it } from "vitest";
import {
	parseReviewThreads,
	readConversation,
	threadViewFrom,
} from "../../../extensions/pr-workflow/threads.js";
import type {
	ChangeRef,
	ConversationFacet,
	Message,
	Thread,
} from "../../../lib/review/index.js";

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

describe("threadViewFrom", () => {
	const comment = (id: string): Message => ({
		id,
		author: { id: "octocat" },
		body: "a remark",
		createdAt: "2026-07-01T00:00:00Z",
		url: `https://github.com/o/r/pull/1#${id}`,
	});

	it("carries a line anchor onto the view's path and line", () => {
		const [view] = threadViewFrom(
			[
				{
					id: "PRRT_1",
					resolved: false,
					stale: false,
					anchor: {
						subject: "line",
						path: "lib/widget.ts",
						blob: "new",
						line: 42,
					},
					comments: [comment("c1")],
				},
			],
			[],
		);

		expect(view).toEqual({
			id: "PRRT_1",
			kind: "review-thread",
			isResolved: false,
			isOutdated: false,
			path: "lib/widget.ts",
			line: 42,
			comments: [
				{
					id: "c1",
					author: "octocat",
					body: "a remark",
					createdAt: "2026-07-01T00:00:00Z",
					url: "https://github.com/o/r/pull/1#c1",
				},
			],
		});
	});

	it("keeps the file but drops the line when only the file is left", () => {
		// A force-push strands a thread: the provider degrades the
		// anchor to the file it still knows.
		const [view] = threadViewFrom(
			[
				{
					id: "PRRT_2",
					resolved: false,
					anchor: { subject: "file", path: "lib/widget.ts" },
					comments: [comment("c2")],
				},
			],
			[],
		);

		expect(view.path).toBe("lib/widget.ts");
		expect(view.line).toBeNull();
	});

	it("still calls an unanchored thread a review thread", () => {
		// A thread that lost its anchor entirely is not a
		// review-level comment: it can still be replied to and
		// resolved, so conflating the two would refuse both.
		const [view] = threadViewFrom(
			[{ id: "PRRT_3", resolved: true, comments: [comment("c3")] }],
			[],
		);

		expect(view.kind).toBe("review-thread");
		expect(view.path).toBeNull();
		expect(view.line).toBeNull();
		expect(view.isResolved).toBe(true);
	});

	it("reports an unknown staleness as not outdated", () => {
		// The substrate leaves `stale` absent when the provider
		// cannot tell, which is different from known-current, but
		// the view has only a boolean to say it with.
		const [view] = threadViewFrom(
			[{ id: "PRRT_4", resolved: false, comments: [comment("c4")] }],
			[],
		);

		expect(view.isOutdated).toBe(false);
	});

	it("turns each top-level comment into a review-level entry", () => {
		const views = threadViewFrom([], [comment("m1")]);

		expect(views).toEqual([
			{
				id: "m1",
				kind: "review-level",
				isResolved: false,
				isOutdated: false,
				path: null,
				line: null,
				comments: [
					{
						id: "m1",
						author: "octocat",
						body: "a remark",
						createdAt: "2026-07-01T00:00:00Z",
						url: "https://github.com/o/r/pull/1#m1",
					},
				],
			},
		]);
	});

	it("lists anchored threads before the change-wide comments", () => {
		// The numbered [T#] list is what a person replies against,
		// so the order the actions see has to stay put.
		const views = threadViewFrom(
			[{ id: "PRRT_5", resolved: false, comments: [comment("c5")] }],
			[comment("m2")],
		);

		expect(views.map((view) => view.id)).toEqual(["PRRT_5", "m2"]);
	});

	it("fills in a blank when the provider omits a date or a link", () => {
		// Both are optional on the substrate's message and required
		// on the view, and a renderer would rather have an empty
		// string than the word undefined.
		const [view] = threadViewFrom(
			[
				{
					id: "PRRT_6",
					resolved: false,
					comments: [{ id: "c6", author: { id: "ghost" }, body: "terse" }],
				},
			],
			[],
		);

		expect(view.comments[0].createdAt).toBe("");
		expect(view.comments[0].url).toBe("");
	});
});

describe("readConversation", () => {
	const change: ChangeRef = {
		provider: "github",
		repo: { key: "github:o/r" },
		id: "7",
		label: "o/r#7",
	};

	const message = (id: string): Message => ({
		id,
		author: { id: "octocat" },
		body: "a remark",
	});

	/** A facet that answers the two reads and records the asking. */
	function facet(
		threads: Thread[],
		messages: Message[],
	): { conversation: ConversationFacet; asked: string[] } {
		const asked: string[] = [];
		const refuse = () => Promise.reject(new Error("not part of this read"));
		const conversation = {
			async threads(ref: ChangeRef) {
				asked.push(`threads ${ref.id}`);
				return threads;
			},
			async messages(ref: ChangeRef) {
				asked.push(`messages ${ref.id}`);
				return messages;
			},
			reviews: refuse,
			postReview: refuse,
			reply: refuse,
			resolve: refuse,
			comment: refuse,
		} as unknown as ConversationFacet;
		return { conversation, asked };
	}

	it("returns the anchored threads and the change-wide comments as one view", async () => {
		const { conversation } = facet(
			[{ id: "PRRT_1", resolved: false, comments: [message("c1")] }],
			[message("m1")],
		);

		const view = await readConversation(conversation, change);

		expect(view.map((entry) => [entry.id, entry.kind])).toEqual([
			["PRRT_1", "review-thread"],
			["m1", "review-level"],
		]);
	});

	it("asks the facet for both halves of the conversation", async () => {
		// Reading only the threads is the mistake that loses every
		// top-level comment, and it looks like a working read.
		const { conversation, asked } = facet([], []);

		await readConversation(conversation, change);

		expect(asked).toContain("threads 7");
		expect(asked).toContain("messages 7");
	});

	it("fetches the two at once rather than one after the other", async () => {
		// Neither read depends on the other, and a busy pull request
		// pays for both in pages.
		let running = 0;
		let peak = 0;
		const slow = async <T>(answer: T): Promise<T> => {
			running += 1;
			peak = Math.max(peak, running);
			await new Promise((resume) => setTimeout(resume, 5));
			running -= 1;
			return answer;
		};
		const conversation = {
			threads: () => slow<Thread[]>([]),
			messages: () => slow<Message[]>([]),
		} as unknown as ConversationFacet;

		await readConversation(conversation, change);

		expect(peak).toBe(2);
	});
});

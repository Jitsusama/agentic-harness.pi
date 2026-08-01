import { describe, expect, it } from "vitest";
import {
	anchorPath,
	type ChangeRef,
	createGitHubProvider,
	type Thread,
} from "../../../lib/review";
import { callMatching, fakeExec, type Reply } from "./support/fake-exec.js";

const repo = { key: "github:Shopify/world" };
const ref: ChangeRef = {
	provider: "github",
	repo,
	id: "123",
	label: "Shopify/world#123",
};

function provider(replies: Reply[]) {
	const { exec, calls } = fakeExec(replies);
	return { gh: createGitHubProvider({ exec }), calls };
}

/** A page of review threads in GraphQL's shape. */
function threadPage(
	threads: unknown[],
	pageInfo: { hasNextPage: boolean; endCursor: string | null },
) {
	return JSON.stringify({
		data: {
			repository: {
				pullRequest: { reviewThreads: { nodes: threads, pageInfo } },
			},
		},
	});
}

const oneThread = {
	id: "PRRT_kwDO",
	isResolved: false,
	isOutdated: false,
	path: "lib/app.ts",
	line: 12,
	startLine: null,
	diffSide: "RIGHT",
	comments: {
		nodes: [
			{
				id: "PRRC_kwDO",
				databaseId: 555,
				author: { login: "someone" },
				body: "why?",
				createdAt: "2026-07-01T00:00:00Z",
				url: "https://github.com/x/y/pull/1#discussion_r555",
			},
		],
	},
};

describe("reading reviews", () => {
	it("maps GitHub's review events onto verdicts", async () => {
		const reviews = JSON.stringify([
			{
				id: 1,
				user: { login: "a" },
				state: "APPROVED",
				body: "fine",
				submitted_at: "2026-07-01T00:00:00Z",
			},
			{ id: 2, user: { login: "b" }, state: "CHANGES_REQUESTED", body: "no" },
			{ id: 3, user: { login: "c" }, state: "COMMENTED", body: "hm" },
		]);
		const { gh } = provider([{ when: ["pulls/123/reviews"], stdout: reviews }]);
		const found = await gh.conversation?.reviews(ref);
		expect(found?.map((review) => review.verdict)).toEqual([
			"approve",
			"request-changes",
			"comment",
		]);
		expect(found?.[0].nativeVerdict).toBe("APPROVED");
	});
});

describe("reading threads", () => {
	it("names who resolved a thread, which the follow-up view reports", async () => {
		// `resolvedBy` was read by the follow-up view and selected by no query,
		// so every resolved thread degraded to "resolved with no reply" and
		// never named anybody. That attribution is the whole feature.
		const { gh } = provider([
			{
				when: ["reviewThreads"],
				stdout: threadPage(
					[
						{
							...oneThread,
							isResolved: true,
							resolvedBy: { login: "closer", name: "Cl Oser" },
						},
					],
					{ hasNextPage: false, endCursor: null },
				),
			},
		]);

		const [thread] = (await gh.conversation?.threads(ref)) ?? [];

		expect(thread.resolvedBy).toEqual({ id: "closer", name: "Cl Oser" });
	});

	it("leaves the resolver unnamed on a thread nobody has closed", async () => {
		// Nobody, not the ghost user: an absent actor means the thread is open,
		// and a placeholder would assert that somebody acted.
		const { gh } = provider([
			{
				when: ["reviewThreads"],
				stdout: threadPage([{ ...oneThread, resolvedBy: null }], {
					hasNextPage: false,
					endCursor: null,
				}),
			},
		]);

		const [thread] = (await gh.conversation?.threads(ref)) ?? [];

		expect(thread.resolvedBy).toBeUndefined();
	});

	it("maps a thread onto the neutral shape with a git-side anchor", async () => {
		const { gh } = provider([
			{
				when: ["reviewThreads"],
				stdout: threadPage([oneThread], {
					hasNextPage: false,
					endCursor: null,
				}),
			},
		]);
		const [thread] = (await gh.conversation?.threads(ref)) ?? [];
		expect(thread.id).toBe("PRRT_kwDO");
		expect(thread.resolved).toBe(false);
		expect(thread.anchor?.subject).toBe("line");
		expect(thread.anchor && anchorPath(thread.anchor)).toBe("lib/app.ts");
		expect(thread.anchor?.subject === "line" && thread.anchor.blob).toBe("new");
		expect(thread.comments[0].body).toBe("why?");
	});

	it("reads a left-side anchor as the old side", async () => {
		const onOldSide = { ...oneThread, diffSide: "LEFT" };
		const { gh } = provider([
			{
				when: ["reviewThreads"],
				stdout: threadPage([onOldSide], {
					hasNextPage: false,
					endCursor: null,
				}),
			},
		]);
		const [thread] = (await gh.conversation?.threads(ref)) ?? [];
		expect(thread.anchor?.subject === "line" && thread.anchor.blob).toBe("old");
	});

	it("reads a whole-file remark as one, not as a remark on line 1", async () => {
		// GitHub answers `line: 1` for a file-level comment, so reading the
		// line first meant posting a remark about a file, reading it back, and
		// reporting it somewhere it was never aimed. Nobody would catch that
		// from a listing: line 1 is a plausible place to have said something.
		// Found by driving it, after the write side already worked.
		const aboutTheFile = { ...oneThread, subjectType: "FILE", line: 1 };
		const { gh } = provider([
			{
				when: ["reviewThreads"],
				stdout: threadPage([aboutTheFile], {
					hasNextPage: false,
					endCursor: null,
				}),
			},
		]);
		const [thread] = (await gh.conversation?.threads(ref)) ?? [];
		expect(thread.anchor?.subject).toBe("file");
	});

	it("still reads a line remark as a line remark", async () => {
		// The other half, since a check for one value is half a check.
		const onALine = { ...oneThread, subjectType: "LINE" };
		const { gh } = provider([
			{
				when: ["reviewThreads"],
				stdout: threadPage([onALine], {
					hasNextPage: false,
					endCursor: null,
				}),
			},
		]);
		const [thread] = (await gh.conversation?.threads(ref)) ?? [];
		expect(thread.anchor?.subject).toBe("line");
	});

	it("reports an outdated thread as stale", async () => {
		const stranded = { ...oneThread, isOutdated: true, line: null };
		const { gh } = provider([
			{
				when: ["reviewThreads"],
				stdout: threadPage([stranded], {
					hasNextPage: false,
					endCursor: null,
				}),
			},
		]);
		const [thread] = (await gh.conversation?.threads(ref)) ?? [];
		expect(thread.stale).toBe(true);
	});

	it("keeps paging until GitHub says there is no more", async () => {
		const second = { ...oneThread, id: "PRRT_second" };
		const { gh, calls } = provider([
			{
				when: ["after=cursor-1"],
				stdout: threadPage([second], {
					hasNextPage: false,
					endCursor: null,
				}),
			},
			{
				when: ["reviewThreads"],
				stdout: threadPage([oneThread], {
					hasNextPage: true,
					endCursor: "cursor-1",
				}),
			},
		]);
		const threads = (await gh.conversation?.threads(ref)) ?? [];
		expect(threads.map((thread) => thread.id)).toEqual([
			"PRRT_kwDO",
			"PRRT_second",
		]);
		expect(calls).toHaveLength(2);
	});

	it("refuses a response with no reviewThreads rather than reading none", async () => {
		// The envelope walk defaulted a missing object to an empty one, so a
		// schema change, a partial error payload or a renamed field all came
		// back as a pull request with no threads. That is the worst shape a
		// read can fail in: the person concludes nobody commented and moves
		// on, and nothing anywhere says otherwise.
		const { gh } = provider([
			{
				when: ["reviewThreads"],
				stdout: JSON.stringify({
					data: { repository: { pullRequest: {} } },
				}),
			},
		]);

		await expect(gh.conversation?.threads(ref)).rejects.toThrow(
			/reviewThreads/,
		);
	});

	it("still answers none when reviewThreads is there and empty", async () => {
		// The other half of the same distinction, and the reason the refusal
		// checks for the field rather than for the count. A change with no
		// comments on it is ordinary and must not look like a broken read.
		const { gh } = provider([
			{
				when: ["reviewThreads"],
				stdout: threadPage([], { hasNextPage: false, endCursor: null }),
			},
		]);

		await expect(gh.conversation?.threads(ref)).resolves.toEqual([]);
	});
});

describe("reading messages", () => {
	it("reads top-level comments with their reactions", async () => {
		const comments = JSON.stringify([
			{
				id: 900,
				user: { login: "a" },
				body: "nice",
				created_at: "2026-07-01T00:00:00Z",
				reactions: { "+1": 2, rocket: 1, laugh: 0, url: "x" },
			},
		]);
		const { gh } = provider([
			{ when: ["issues/123/comments"], stdout: comments },
		]);
		const [message] = (await gh.conversation?.messages(ref)) ?? [];
		expect(message.body).toBe("nice");
		expect(message.reactions).toEqual([
			{ reaction: "+1", count: 2 },
			{ reaction: "rocket", count: 1 },
		]);
	});
});

describe("reading a list that runs past one page", () => {
	// GitHub answers a REST list with thirty records and says
	// nothing about the rest. A long review is exactly where the
	// tail matters, so every list read has to ask for all of it.
	it("asks for every comment, not just the first page", async () => {
		const { gh, calls } = provider([
			{ when: ["issues/123/comments"], stdout: "[]" },
		]);

		await gh.conversation?.messages(ref);

		const call = callMatching(calls, "issues/123/comments");
		expect(call?.args).toContain("--paginate");
	});

	it("asks for every review, not just the first page", async () => {
		const { gh, calls } = provider([
			{ when: ["pulls/123/reviews"], stdout: "[]" },
		]);

		await gh.conversation?.reviews(ref);

		const call = callMatching(calls, "pulls/123/reviews");
		expect(call?.args).toContain("--paginate");
	});

	it("fills each page so a long list costs fewer round trips", async () => {
		const { gh, calls } = provider([
			{ when: ["issues/123/comments"], stdout: "[]" },
		]);

		await gh.conversation?.messages(ref);

		const call = callMatching(calls, "issues/123/comments");
		expect(call?.args.join(" ")).toContain("per_page=100");
	});
});

describe("posting a review", () => {
	it("sends the verdict and anchored comments through a payload file", async () => {
		const { gh, calls } = provider([
			{ when: ["pulls/123/reviews"], stdout: '{"id":9,"html_url":"u"}' },
		]);
		const posted = await gh.conversation?.postReview(ref, {
			verdict: "request-changes",
			body: "two things",
			comments: [
				{
					anchor: {
						subject: "line",
						path: "lib/app.ts",
						blob: "new",
						line: 12,
						startLine: 10,
					},
					body: "here",
				},
				{
					anchor: { subject: "file", path: "lib/other.ts" },
					body: "whole file",
				},
			],
		});
		expect(posted?.url).toBe("u");

		const call = callMatching(calls, "reviews");
		const payload = JSON.parse(call?.input ?? "{}");
		expect(payload.event).toBe("REQUEST_CHANGES");
		expect(payload.comments[0]).toEqual({
			path: "lib/app.ts",
			body: "here",
			line: 12,
			side: "RIGHT",
			start_line: 10,
			start_side: "RIGHT",
		});
		expect(payload.comments[1]).toEqual({
			path: "lib/other.ts",
			body: "whole file",
			subject_type: "file",
		});
	});

	it("translates an old-side anchor to the left side", async () => {
		const { gh, calls } = provider([{ when: ["reviews"], stdout: "{}" }]);
		await gh.conversation?.postReview(ref, {
			verdict: "comment",
			body: "",
			comments: [
				{
					anchor: {
						subject: "line",
						path: "lib/app.ts",
						blob: "old",
						line: 4,
					},
					body: "gone",
				},
			],
		});
		const call = callMatching(calls, "reviews");
		const payload = JSON.parse(call?.input ?? "{}");
		expect(payload.comments[0].side).toBe("LEFT");
	});
});

describe("replying, resolving and reacting", () => {
	const thread: Thread = {
		id: "PRRT_kwDO",
		resolved: false,
		comments: [
			{
				id: "rc:555",
				author: { id: "someone" },
				body: "why?",
			},
		],
	};

	it("replies keyed by the thread's own id", async () => {
		const { gh, calls } = provider([
			{
				when: ["addPullRequestReviewThreadReply"],
				stdout: JSON.stringify({
					data: {
						addPullRequestReviewThreadReply: {
							comment: { id: "PRRC_new", url: "u" },
						},
					},
				}),
			},
		]);
		const posted = await gh.conversation?.reply(ref, thread, "because");
		expect(posted?.url).toBe("u");
		expect(callMatching(calls, "threadId=PRRT_kwDO")).toBeTruthy();
	});

	it("resolves and unresolves the same thread", async () => {
		const { gh, calls } = provider([
			{ when: ["resolveReviewThread"], stdout: "{}" },
			{ when: ["unresolveReviewThread"], stdout: "{}" },
		]);
		await gh.conversation?.resolve(ref, thread);
		await gh.conversation?.unresolve?.(ref, thread);
		expect(callMatching(calls, "resolveReviewThread")).toBeTruthy();
		expect(callMatching(calls, "unresolveReviewThread")).toBeTruthy();
	});

	it("posts a top-level comment", async () => {
		const { gh, calls } = provider([
			{ when: ["issues/123/comments"], stdout: '{"id":1,"html_url":"u"}' },
		]);
		await gh.conversation?.comment(ref, "a remark");
		expect(
			callMatching(calls, "issues/123/comments")?.args.join(" "),
		).toContain("a remark");
	});

	it("reacts to a review comment on its own route", async () => {
		const { gh, calls } = provider([
			{ when: ["comments/555/reactions"], stdout: "{}" },
		]);
		await gh.conversation?.react?.(ref, thread.comments[0], "rocket");
		const args = callMatching(calls, "reactions")?.args.join(" ");
		expect(args).toContain("pulls/comments/555/reactions");
		expect(args).toContain("content=rocket");
	});

	it("reacts to a top-level message on the issue route", async () => {
		const { gh, calls } = provider([
			{ when: ["issues/comments/900/reactions"], stdout: "{}" },
		]);
		await gh.conversation?.react?.(
			ref,
			{ id: "ic:900", author: { id: "a" }, body: "nice" },
			"+1",
		);
		expect(callMatching(calls, "issues/comments/900/reactions")).toBeTruthy();
	});

	it("refuses to react to something whose kind it cannot tell", async () => {
		const { gh } = provider([]);
		await expect(
			gh.conversation?.react?.(
				ref,
				{ id: "mystery", author: { id: "a" }, body: "?" },
				"+1",
			),
		).rejects.toThrow(/cannot tell|unrecognized/i);
	});
});

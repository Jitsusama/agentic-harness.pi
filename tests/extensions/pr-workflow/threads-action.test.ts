import { describe, expect, it, vi } from "vitest";
import { createPrWorkflowState } from "../../../extensions/pr-workflow/state.js";
import type { ReviewThread } from "../../../extensions/pr-workflow/threads.js";
import {
	formatThreadsView,
	loadThreadsAction,
	replyToThreadAction,
	resolveThreadAction,
} from "../../../extensions/pr-workflow/threads-action.js";

function activeState() {
	const state = createPrWorkflowState();
	state.active = true;
	state.pr = {
		reference: { owner: "o", repo: "r", number: 7 },
		loadedAt: "2026-05-19T00:00:00Z",
		metadata: null,
		files: null,
		stack: null,
	};
	return state;
}

function thread(overrides: Partial<ReviewThread> = {}): ReviewThread {
	return {
		id: "T1",
		kind: "review-thread",
		isResolved: false,
		isOutdated: false,
		path: "src/foo.ts",
		line: 10,
		comments: [
			{
				id: "C1",
				author: "octocat",
				body: "Could this be simpler?",
				createdAt: "2024-01-01T00:00:00Z",
				url: "https://example.com/c1",
			},
		],
		...overrides,
	};
}

describe("loadThreadsAction", () => {
	it("requires a loaded PR", async () => {
		const state = createPrWorkflowState();
		const fetcher = vi.fn();
		const result = await loadThreadsAction({ state, fetcher });
		expect(result.ok).toBe(false);
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("populates state.threads with the fetched list", async () => {
		const state = activeState();
		const fetcher = vi.fn(async () => [thread(), thread({ id: "T2" })]);
		const result = await loadThreadsAction({ state, fetcher });
		expect(result.ok).toBe(true);
		expect(state.threads).not.toBeNull();
		expect(state.threads?.threads).toHaveLength(2);
		expect(state.threads?.prNumber).toBe(7);
		expect(fetcher).toHaveBeenCalledWith(state.pr?.reference);
	});

	it("surfaces fetch failures without poisoning state", async () => {
		const state = activeState();
		const fetcher = vi.fn(async () => {
			throw new Error("boom");
		});
		const result = await loadThreadsAction({ state, fetcher });
		expect(result.ok).toBe(false);
		expect(state.threads).toBeNull();
	});
});

describe("formatThreadsView", () => {
	it("explains the empty state when threads haven't been fetched", () => {
		const state = activeState();
		const view = formatThreadsView(state);
		expect(view).toMatch(/no review threads fetched/i);
	});

	it("explains the empty state when the PR has zero threads", () => {
		const state = activeState();
		state.threads = {
			prNumber: 7,
			fetchedAt: "now",
			mutatedAt: null,
			threads: [],
		};
		expect(formatThreadsView(state)).toMatch(/zero|no.*threads.*on/i);
	});

	it("indexes threads as [T1], [T2] in display order", () => {
		const state = activeState();
		state.threads = {
			prNumber: 7,
			fetchedAt: "now",
			mutatedAt: null,
			threads: [thread(), thread({ id: "T2", path: "src/bar.ts", line: 20 })],
		};
		const view = formatThreadsView(state);
		expect(view).toContain("[T1]");
		expect(view).toContain("[T2]");
		// First indexed thread should come before second in output
		expect(view.indexOf("[T1]")).toBeLessThan(view.indexOf("[T2]"));
	});

	it("marks resolved and outdated threads", () => {
		const state = activeState();
		state.threads = {
			prNumber: 7,
			fetchedAt: "now",
			mutatedAt: null,
			threads: [
				thread({ isResolved: true }),
				thread({ id: "T2", isOutdated: true }),
			],
		};
		const view = formatThreadsView(state);
		expect(view).toMatch(/resolved/i);
		expect(view).toMatch(/outdated/i);
	});

	it("labels review-level comments distinctly from file threads", () => {
		const state = activeState();
		state.threads = {
			prNumber: 7,
			fetchedAt: "now",
			mutatedAt: null,
			threads: [
				thread({
					id: "IC1",
					kind: "review-level",
					path: null,
					line: null,
					comments: [
						{
							id: "IC1",
							author: "octocat",
							body: "Looks good overall.",
							createdAt: "2024-01-01T00:00:00Z",
							url: "https://example.com/ic1",
						},
					],
				}),
			],
		};
		expect(formatThreadsView(state)).toContain("[T1] (review-level)");
	});
});

describe("replyToThreadAction", () => {
	it("requires fetched threads", async () => {
		const state = activeState();
		const sender = vi.fn();
		const result = await replyToThreadAction({
			state,
			index: 1,
			body: "thanks",
			sender,
		});
		expect(result.ok).toBe(false);
		expect(sender).not.toHaveBeenCalled();
	});

	it("translates a 1-based index into a thread id and posts the reply", async () => {
		const state = activeState();
		state.threads = {
			prNumber: 7,
			fetchedAt: "now",
			mutatedAt: null,
			threads: [thread({ id: "TA" }), thread({ id: "TB" })],
		};
		const sender = vi.fn(async () => "https://example.com/new");
		const result = await replyToThreadAction({
			state,
			index: 2,
			body: "thanks",
			sender,
		});
		expect(result.ok).toBe(true);
		expect(sender).toHaveBeenCalledWith("TB", "thanks");
	});

	it("rejects an out-of-range index", async () => {
		const state = activeState();
		state.threads = {
			prNumber: 7,
			fetchedAt: "now",
			mutatedAt: null,
			threads: [thread()],
		};
		const sender = vi.fn();
		const result = await replyToThreadAction({
			state,
			index: 5,
			body: "x",
			sender,
		});
		expect(result.ok).toBe(false);
		expect(sender).not.toHaveBeenCalled();
	});

	it("appends the reply locally and stamps mutatedAt so summary stays consistent", async () => {
		const state = activeState();
		state.threads = {
			prNumber: 7,
			fetchedAt: "2026-05-19T00:00:00Z",
			mutatedAt: null,
			threads: [thread({ id: "TA" })],
		};
		const sender = vi.fn(async () => "https://example.com/new");

		const result = await replyToThreadAction({
			state,
			index: 1,
			body: "Thanks, will land in next commit.",
			sender,
			now: () => "2026-05-19T10:00:00Z",
			author: "jitsusama",
		});

		expect(result.ok).toBe(true);
		const target = state.threads.threads[0];
		expect(target.comments).toHaveLength(2);
		expect(target.comments[1]).toMatchObject({
			author: "jitsusama",
			body: "Thanks, will land in next commit.",
			url: "https://example.com/new",
		});
		expect(state.threads.mutatedAt).toBe("2026-05-19T10:00:00Z");
	});

	it("rejects an empty body", async () => {
		const state = activeState();
		state.threads = {
			prNumber: 7,
			fetchedAt: "now",
			mutatedAt: null,
			threads: [thread()],
		};
		const sender = vi.fn();
		const result = await replyToThreadAction({
			state,
			index: 1,
			body: "   ",
			sender,
		});
		expect(result.ok).toBe(false);
		expect(sender).not.toHaveBeenCalled();
	});

	it("rejects replies to review-level comments", async () => {
		const state = activeState();
		state.threads = {
			prNumber: 7,
			fetchedAt: "now",
			mutatedAt: null,
			threads: [thread({ kind: "review-level", path: null, line: null })],
		};
		const sender = vi.fn();
		const result = await replyToThreadAction({
			state,
			index: 1,
			body: "thanks",
			sender,
		});
		expect(result.ok).toBe(false);
		expect(sender).not.toHaveBeenCalled();
	});
});

describe("resolveThreadAction", () => {
	it("requires fetched threads", async () => {
		const state = activeState();
		const resolver = vi.fn();
		const result = await resolveThreadAction({ state, index: 1, resolver });
		expect(result.ok).toBe(false);
		expect(resolver).not.toHaveBeenCalled();
	});

	it("translates a 1-based index into a thread id and resolves it", async () => {
		const state = activeState();
		state.threads = {
			prNumber: 7,
			fetchedAt: "now",
			mutatedAt: null,
			threads: [thread({ id: "TA" }), thread({ id: "TB" })],
		};
		const resolver = vi.fn(async () => true);
		const result = await resolveThreadAction({ state, index: 1, resolver });
		expect(result.ok).toBe(true);
		expect(resolver).toHaveBeenCalledWith("TA");
	});

	it("rejects an out-of-range index", async () => {
		const state = activeState();
		state.threads = {
			prNumber: 7,
			fetchedAt: "now",
			mutatedAt: null,
			threads: [thread()],
		};
		const resolver = vi.fn();
		const result = await resolveThreadAction({ state, index: 9, resolver });
		expect(result.ok).toBe(false);
		expect(resolver).not.toHaveBeenCalled();
	});

	it("flips isResolved locally and stamps mutatedAt on success", async () => {
		const state = activeState();
		state.threads = {
			prNumber: 7,
			fetchedAt: "2026-05-19T00:00:00Z",
			mutatedAt: null,
			threads: [thread({ id: "TA" })],
		};
		const resolver = vi.fn(async () => true);

		const result = await resolveThreadAction({
			state,
			index: 1,
			resolver,
			now: () => "2026-05-19T10:01:00Z",
		});

		expect(result.ok).toBe(true);
		expect(state.threads.threads[0].isResolved).toBe(true);
		expect(state.threads.mutatedAt).toBe("2026-05-19T10:01:00Z");
	});

	it("warns but still resolves an already-resolved thread (idempotent)", async () => {
		const state = activeState();
		state.threads = {
			prNumber: 7,
			fetchedAt: "now",
			mutatedAt: null,
			threads: [thread({ isResolved: true })],
		};
		const resolver = vi.fn(async () => true);
		const result = await resolveThreadAction({ state, index: 1, resolver });
		expect(result.ok).toBe(true);
		expect(resolver).toHaveBeenCalled();
	});

	it("rejects resolving review-level comments", async () => {
		const state = activeState();
		state.threads = {
			prNumber: 7,
			fetchedAt: "now",
			mutatedAt: null,
			threads: [thread({ kind: "review-level", path: null, line: null })],
		};
		const resolver = vi.fn();
		const result = await resolveThreadAction({ state, index: 1, resolver });
		expect(result.ok).toBe(false);
		expect(resolver).not.toHaveBeenCalled();
	});
});

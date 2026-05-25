import { describe, expect, it } from "vitest";
import { createPrWorkflowState } from "../../../extensions/pr-workflow/state.js";
import {
	loadReviewThreadPromptContext,
	renderReviewThreadPromptContext,
	renderThreadRelation,
	renderThreadRelationForGithub,
} from "../../../extensions/pr-workflow/thread-context.js";
import type { ReviewThread } from "../../../extensions/pr-workflow/threads.js";

function thread(overrides: Partial<ReviewThread> = {}): ReviewThread {
	return {
		id: "thread-1",
		kind: "review-thread",
		isResolved: false,
		isOutdated: false,
		path: "src/auth.ts",
		line: 12,
		comments: [
			{
				id: "comment-1",
				author: "reviewer",
				body: "This already covers the auth bypass.",
				createdAt: "2026-01-01T00:00:00Z",
				url: "https://example.test/comment",
			},
		],
		...overrides,
	};
}

describe("renderReviewThreadPromptContext", () => {
	it("renders compact indexed thread context for reviewer prompts", () => {
		const text = renderReviewThreadPromptContext({ threads: [thread()] });

		expect(text).toContain("Existing review threads");
		expect(text).toContain("[T1] src/auth.ts:12");
		expect(text).toContain("reviewer at 2026-01-01T00:00:00Z");
		expect(text).toContain("auth bypass");
		expect(text).toContain("untrusted user-authored evidence");
		expect(text).toContain("```text");
		expect(text).toContain("substantiate");
		expect(text).toContain("disprove");
		expect(text).toContain("amplify");
	});

	it("fences comment bodies without letting nested fences escape", () => {
		const text = renderReviewThreadPromptContext({
			threads: [
				thread({
					comments: [
						{
							id: "comment-1",
							author: "reviewer",
							body: "quoted ````code``` block",
							createdAt: "2026-01-01T00:00:00Z",
							url: "https://example.test/comment",
						},
					],
				}),
			],
		});

		expect(text).toContain("quoted `​`​`​`code`​`​` block");
		expect(text.match(/```text/g)).toHaveLength(1);
	});

	it("keeps the first comment and latest replies on long threads", () => {
		const text = renderReviewThreadPromptContext({
			threads: [
				thread({
					comments: Array.from({ length: 5 }, (_, index) => ({
						id: `comment-${index + 1}`,
						author: "reviewer",
						body: `comment ${index + 1}`,
						createdAt: `2026-01-0${index + 1}T00:00:00Z`,
						url: `https://example.test/comment-${index + 1}`,
					})),
				}),
			],
		});

		expect(text).toContain("comment 1");
		expect(text).not.toContain("comment 2");
		expect(text).not.toContain("comment 3");
		expect(text).toContain("comment 4");
		expect(text).toContain("comment 5");
	});

	it("surfaces fetch warnings without failing prompt rendering", () => {
		const text = renderReviewThreadPromptContext({
			threads: [],
			warning: "GitHub was unavailable.",
		});

		expect(text).toContain("GitHub was unavailable");
		expect(text).toContain("No existing review threads were available");
	});
});

describe("loadReviewThreadPromptContext", () => {
	it("fetches and stores threads on the workflow state", async () => {
		const state = createPrWorkflowState();
		state.pr = {
			reference: { owner: "o", repo: "r", number: 42 },
			loadedAt: "x",
			metadata: null,
			files: null,
			stack: null,
		};

		const context = await loadReviewThreadPromptContext(state, async () => [
			thread(),
		]);

		expect(context.threads).toHaveLength(1);
		expect(state.threads?.prNumber).toBe(42);
		expect(state.threads?.threads).toHaveLength(1);
		expect(state.threadContextWarning).toBeNull();
	});

	it("stores sanitized warnings when fetching threads fails", async () => {
		const state = createPrWorkflowState();
		state.pr = {
			reference: { owner: "o", repo: "r", number: 42 },
			loadedAt: "x",
			metadata: null,
			files: null,
			stack: null,
		};

		const context = await loadReviewThreadPromptContext(state, async () => {
			throw new Error("token secret-123 failed");
		});

		expect(context.warning).toContain("could not be fetched");
		expect(context.warning).toContain("Error");
		expect(context.warning).not.toContain("secret-123");
		expect(context.warning).not.toContain("local logs");
		expect(state.threadContextWarning).toBe(context.warning);
	});
});

describe("renderThreadRelation", () => {
	it("renders actionable relations and hides new relations", () => {
		expect(
			renderThreadRelation({
				kind: "disputes-existing",
				threadIndex: 3,
				rationale: "The caller now guards this path.",
			}),
		).toBe("disputes [T3]: The caller now guards this path.");
		expect(renderThreadRelation({ kind: "new" })).toBeNull();
	});

	it("renders stable GitHub-facing relations", () => {
		expect(
			renderThreadRelationForGithub(
				{
					kind: "supports-existing",
					threadIndex: 1,
					rationale: "The failing test confirms it.",
				},
				[thread()],
			),
		).toBe(
			"supports existing review thread (https://example.test/comment): The failing test confirms it.",
		);
	});
});

import { describe, expect, it } from "vitest";
import { createPrWorkflowState } from "../../../extensions/pr-workflow/state.js";
import {
	loadReviewThreadPromptContext,
	renderReviewThreadPromptContext,
	renderThreadRelation,
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
		expect(text).toContain("substantiate");
		expect(text).toContain("disprove");
		expect(text).toContain("amplify");
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
});

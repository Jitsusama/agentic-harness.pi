import { describe, expect, it } from "vitest";
import {
	isReviewContextProvider,
	type ReviewContextProvider,
	ReviewContextProviderBroker,
	type ReviewContextRequest,
} from "../../../extensions/pr-workflow/review-context.js";

const REQUEST: ReviewContextRequest = {
	owner: "shop",
	repo: "world",
	prNumber: 123,
	sha: "abc123",
	branch: "feature",
	stage: "council",
};

function provider(
	overrides: Partial<ReviewContextProvider> = {},
): ReviewContextProvider {
	return {
		id: "context",
		context: () => "base context",
		...overrides,
	};
}

describe("ReviewContextProviderBroker", () => {
	it("collects matching provider context in priority order", async () => {
		const broker = new ReviewContextProviderBroker();
		broker.register(
			provider({
				id: "low",
				priority: 1,
				context: () => "low priority",
			}),
		);
		broker.register(
			provider({
				id: "high",
				priority: 100,
				context: () => "high priority",
			}),
		);

		await expect(broker.promptAddendum(REQUEST)).resolves.toBe(
			"high priority\n\nlow priority",
		);
	});

	it("skips providers that decline the request and trims empty context", async () => {
		const broker = new ReviewContextProviderBroker();
		broker.register(
			provider({
				id: "declined",
				canHandle: () => false,
				context: () => "should not appear",
			}),
		);
		broker.register(
			provider({
				id: "empty",
				context: () => "  ",
			}),
		);
		broker.register(
			provider({
				id: "world",
				canHandle: (request) => request.owner === "shop",
				context: (request) => `context for ${request.owner}/${request.repo}`,
			}),
		);

		await expect(broker.promptAddendum(REQUEST)).resolves.toBe(
			"context for shop/world",
		);
	});

	it("replaces providers with the same id", async () => {
		const broker = new ReviewContextProviderBroker();
		broker.register(provider({ id: "world", context: () => "old" }));
		broker.register(provider({ id: "world", context: () => "new" }));

		await expect(broker.promptAddendum(REQUEST)).resolves.toBe("new");
		expect(broker.providerIds()).toEqual(["world"]);
	});
});

describe("isReviewContextProvider", () => {
	it("accepts structurally-valid event-bus providers", () => {
		expect(isReviewContextProvider(provider())).toBe(true);
	});

	it("rejects invalid provider payloads", () => {
		expect(isReviewContextProvider(null)).toBe(false);
		expect(isReviewContextProvider({ id: "bad" })).toBe(false);
		expect(
			isReviewContextProvider({
				id: "bad",
				context: () => "x",
				canHandle: "not a function",
			}),
		).toBe(false);
	});
});

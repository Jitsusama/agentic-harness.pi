import { describe, expect, it } from "vitest";
import {
	addFinding,
	addReaction,
	addReply,
	addResolution,
	type ConversationCapabilities,
	type ConversationFacet,
	compilePlan,
	type DraftState,
	emptyDraft,
	type LineAnchor,
	publishPlan,
	type ReviewProvider,
	type ReviewTarget,
	setVerdict,
	type Thread,
} from "../../../lib/review";
import { stubProvider } from "./support/stub-provider.js";

const target: ReviewTarget = {
	kind: "proposal",
	change: {
		provider: "forge",
		repo: { key: "forge:o/r" },
		id: "7",
	},
};

const anchor: LineAnchor = {
	subject: "line",
	path: "lib/app.ts",
	blob: "new",
	line: 3,
};

const thread: Thread = {
	id: "t1",
	resolved: false,
	comments: [{ id: "c1", author: { id: "someone" }, body: "why?" }],
};

const capabilities: ConversationCapabilities = {
	anchoredBatchReview: true,
	fileLevelComments: true,
	multiLineRanges: true,
	suggestions: false,
	unresolve: true,
	reactions: ["rocket"],
	topLevelThreading: false,
	pendingReviews: false,
	staleness: "pinned",
};

/** Records what it was asked to do, and can be told to fail. */
function recordingProvider(
	failures: Partial<Record<keyof ConversationFacet, string>> = {},
	omit: (keyof ConversationFacet)[] = [],
): { provider: ReviewProvider; calls: string[] } {
	const calls: string[] = [];
	const guard = async (name: keyof ConversationFacet) => {
		calls.push(name);
		const failure = failures[name];
		if (failure) throw new Error(failure);
	};
	const conversation: ConversationFacet = {
		reviews: async () => [],
		threads: async () => [],
		messages: async () => [],
		postReview: async () => {
			await guard("postReview");
			return { id: "r1", url: "https://forge/r1" };
		},
		reply: async () => {
			await guard("reply");
			return { id: "c2" };
		},
		resolve: async () => {
			await guard("resolve");
		},
		comment: async () => {
			await guard("comment");
			return { id: "m1" };
		},
		react: async () => {
			await guard("react");
		},
	};
	for (const name of omit) delete conversation[name];
	return {
		provider: stubProvider({
			id: "forge",
			priority: 100,
			capabilities: { conversation: capabilities },
			facets: { conversation },
		}),
		calls,
	};
}

function draft(): DraftState {
	return emptyDraft("d1", target);
}

function planOf(state: DraftState) {
	return compilePlan(state, { capabilities: { conversation: capabilities } });
}

describe("publishPlan", () => {
	it("does nothing for a plan with no operations", async () => {
		const { provider, calls } = recordingProvider();
		const outcome = await publishPlan(planOf(draft()), provider);
		expect(calls).toEqual([]);
		expect(outcome.ok).toBe(true);
		expect(outcome.outcomes).toEqual([]);
	});

	it("posts the review and reports what came back", async () => {
		let state = addFinding(draft(), { anchor, body: "leaks" });
		state = setVerdict(state, "request-changes", "one thing");
		const { provider, calls } = recordingProvider();
		const outcome = await publishPlan(planOf(state), provider);
		expect(calls).toEqual(["postReview"]);
		expect(outcome.ok).toBe(true);
		expect(outcome.outcomes[0].posted?.url).toBe("https://forge/r1");
	});

	it("runs every kind of operation in the order planned", async () => {
		let state = addFinding(draft(), { anchor, body: "leaks" });
		state = addReply(state, thread, "context");
		state = addResolution(state, thread);
		state = addReaction(state, thread.comments[0], "rocket");
		const { provider, calls } = recordingProvider();
		await publishPlan(planOf(state), provider);
		expect(calls).toEqual(["postReview", "reply", "resolve", "react"]);
	});

	it("keeps going after a failure and records which one failed", async () => {
		let state = addFinding(draft(), { anchor, body: "leaks" });
		state = addReply(state, thread, "context");
		state = addResolution(state, thread);
		const { provider, calls } = recordingProvider({ reply: "thread is gone" });
		const outcome = await publishPlan(planOf(state), provider);
		expect(calls).toEqual(["postReview", "reply", "resolve"]);
		expect(outcome.ok).toBe(false);
		expect(outcome.outcomes.map((entry) => entry.ok)).toEqual([
			true,
			false,
			true,
		]);
		expect(outcome.outcomes[1].error).toContain("thread is gone");
	});

	it("names the items an operation carried, so a draft can be pruned", async () => {
		const state = addReply(draft(), thread, "context");
		const { provider } = recordingProvider();
		const outcome = await publishPlan(planOf(state), provider);
		expect(outcome.outcomes[0].itemIds).toEqual(["1"]);
	});

	it("reports an operation the provider cannot perform", async () => {
		const state = addReaction(draft(), thread.comments[0], "rocket");
		const { provider, calls } = recordingProvider({}, ["react"]);
		const outcome = await publishPlan(planOf(state), provider);
		expect(calls).toEqual([]);
		expect(outcome.ok).toBe(false);
		expect(outcome.outcomes[0].error).toMatch(/cannot|does not/i);
	});

	it("refuses a plan whose target nothing hosts", async () => {
		const local = emptyDraft("d2", {
			kind: "range",
			repo: { key: "local:/src/app" },
			base: "main",
			head: "topic",
		});
		const state = setVerdict(local, "approve", "fine");
		const { provider, calls } = recordingProvider();
		const outcome = await publishPlan(planOf(state), provider);
		expect(calls).toEqual([]);
		expect(outcome.ok).toBe(false);
		expect(outcome.outcomes[0].error).toMatch(/not hosted|no change/i);
	});

	it("refuses a provider with no conversation facet at all", async () => {
		const state = setVerdict(draft(), "approve", "fine");
		const bare = stubProvider({ id: "forge", priority: 100 });
		const outcome = await publishPlan(planOf(state), bare);
		expect(outcome.ok).toBe(false);
		expect(outcome.outcomes[0].error).toMatch(/conversation/i);
	});
});

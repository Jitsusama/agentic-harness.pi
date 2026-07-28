import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type ConversationCapabilities,
	type ConversationFacet,
	createDraftStore,
	type DraftDeps,
	type LineAnchor,
	openDraft,
	type ReviewProvider,
	type ReviewTarget,
	resumeDraft,
	type Thread,
} from "../../../lib/review";
import { stubProvider } from "./support/stub-provider.js";

const target: ReviewTarget = {
	kind: "proposal",
	change: { provider: "forge", repo: { key: "forge:o/r" }, id: "7" },
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

/** A provider that succeeds, or fails the named methods. */
function forge(
	failures: Partial<Record<keyof ConversationFacet, string>> = {},
): ReviewProvider {
	const guard = async (name: keyof ConversationFacet) => {
		const failure = failures[name];
		if (failure) throw new Error(failure);
	};
	const conversation: ConversationFacet = {
		reviews: async () => [],
		threads: async () => [],
		messages: async () => [],
		postReview: async () => {
			await guard("postReview");
			return { id: "r1" };
		},
		reply: async () => {
			await guard("reply");
			return { id: "c2" };
		},
		resolve: async () => guard("resolve"),
		comment: async () => {
			await guard("comment");
			return { id: "m1" };
		},
		react: async () => guard("react"),
	};
	return stubProvider({
		id: "forge",
		priority: 100,
		capabilities: { conversation: capabilities },
		facets: { conversation },
	});
}

let root: string;
let deps: DraftDeps;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "review-handle-"));
	deps = { store: createDraftStore(root) };
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("openDraft", () => {
	it("starts a draft about the target and saves it at once", async () => {
		const draft = await openDraft(target, deps);
		expect(draft.state.target).toEqual(target);
		expect(await deps.store.load(draft.id)).toBeTruthy();
	});

	it("gives the draft a legible id naming what it is about", async () => {
		const draft = await openDraft(target, deps);
		expect(draft.id).toContain("7");
	});

	it("resumes the draft already open for that target", async () => {
		const first = await openDraft(target, deps);
		await first.addFinding({ anchor, body: "leaks" });
		const second = await openDraft(target, deps);
		expect(second.id).toBe(first.id);
		expect(second.state.items).toHaveLength(1);
	});

	it("keeps drafts for different targets apart", async () => {
		const one = await openDraft(target, deps);
		const two = await openDraft(
			{ kind: "range", repo: { key: "local:/a" }, base: "main", head: "x" },
			deps,
		);
		expect(two.id).not.toBe(one.id);
	});

	it("persists every change as it is made", async () => {
		const draft = await openDraft(target, deps);
		await draft.addFinding({ anchor, body: "leaks" });
		await draft.setVerdict("request-changes", "one thing");
		const stored = await deps.store.load(draft.id);
		expect(stored?.items).toHaveLength(1);
		expect(stored?.verdict).toBe("request-changes");
	});

	it("hands back the id of a finding so it can be dropped again", async () => {
		const draft = await openDraft(target, deps);
		const id = await draft.addFinding({ anchor, body: "leaks" });
		await draft.remove(id);
		expect(draft.state.items).toEqual([]);
	});

	it("takes replies, resolutions and reactions", async () => {
		const draft = await openDraft(target, deps);
		await draft.replyTo(thread, "context");
		await draft.resolveThread(thread);
		await draft.react(thread.comments[0], "rocket");
		expect(draft.state.items.map((item) => item.kind)).toEqual([
			"reply",
			"resolution",
			"reaction",
		]);
	});

	it("plans against the capabilities it is given", async () => {
		const draft = await openDraft(target, deps);
		await draft.addFinding({ anchor, body: "leaks" });
		const plan = draft.plan({ capabilities: { conversation: capabilities } });
		expect(plan.ops).toHaveLength(1);
	});

	it("renders without needing a provider at all", async () => {
		const draft = await openDraft(target, deps);
		await draft.addFinding({ anchor, body: "leaks" });
		expect(draft.render().markdown).toContain("leaks");
	});
});

describe("publishing through the handle", () => {
	it("empties the draft when everything lands", async () => {
		const draft = await openDraft(target, deps);
		await draft.addFinding({ anchor, body: "leaks" });
		await draft.replyTo(thread, "context");
		const outcome = await draft.publish(
			draft.plan({ capabilities: { conversation: capabilities } }),
			forge(),
		);
		expect(outcome.ok).toBe(true);
		expect(draft.state.items).toEqual([]);
		expect((await deps.store.load(draft.id))?.items).toEqual([]);
	});

	it("keeps only what did not land, so a retry cannot double-post", async () => {
		const draft = await openDraft(target, deps);
		await draft.addFinding({ anchor, body: "leaks" });
		const replyId = await draft.replyTo(thread, "context");
		const outcome = await draft.publish(
			draft.plan({ capabilities: { conversation: capabilities } }),
			forge({ reply: "thread is gone" }),
		);
		expect(outcome.ok).toBe(false);
		expect(draft.state.items.map((item) => item.id)).toEqual([replyId]);
	});

	it("clears the verdict once the review carrying it has landed", async () => {
		const draft = await openDraft(target, deps);
		await draft.setVerdict("approve", "looks right");
		await draft.publish(
			draft.plan({ capabilities: { conversation: capabilities } }),
			forge(),
		);
		expect(draft.state.verdict).toBeUndefined();
	});

	it("keeps the verdict when the review did not land", async () => {
		const draft = await openDraft(target, deps);
		await draft.setVerdict("approve", "looks right");
		await draft.publish(
			draft.plan({ capabilities: { conversation: capabilities } }),
			forge({ postReview: "forge said no" }),
		);
		expect(draft.state.verdict).toBe("approve");
	});
});

describe("resumeDraft", () => {
	it("finds nothing for an id that was never saved", async () => {
		expect(await resumeDraft("ghost", deps)).toBeUndefined();
	});

	it("picks a draft back up by id", async () => {
		const draft = await openDraft(target, deps);
		await draft.addFinding({ anchor, body: "leaks" });
		const resumed = await resumeDraft(draft.id, deps);
		expect(resumed?.state.items).toHaveLength(1);
	});
});

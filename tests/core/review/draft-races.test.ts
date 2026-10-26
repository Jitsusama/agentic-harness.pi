/**
 * A draft that survives being interrupted and stopped.
 *
 * Publishing is several requests, and a session can die or be stopped
 * between any two of them. What is on disk then decides what a retry
 * sends, so the record has to say exactly what landed at every point,
 * not only once the whole plan is through.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type ChangeRef,
	type ConversationCapabilities,
	type ConversationFacet,
	createDraftStore,
	type DraftDeps,
	type LineAnchor,
	openDraft,
	publishAcross,
	type ReviewProvider,
	type ReviewTarget,
	type Thread,
} from "../../../lib/core/review/index.ts";
import { stubProvider } from "../../support/stub-provider.ts";

const changeOf = (id: string): ChangeRef => ({
	provider: "forge",
	repo: { key: "forge:o/r" },
	id,
	label: `o/r#${id}`,
});
const targetOf = (id: string): ReviewTarget => ({
	kind: "change",
	change: changeOf(id),
});

const anchor: LineAnchor = {
	subject: "line",
	path: "lib/app.ts",
	blob: "new",
	line: 3,
};

const thread: Thread = {
	id: "t1",
	resolved: false,
	anchor,
	comments: [{ id: "c1", author: { id: "someone" }, body: "why?" }],
};

const capabilities: ConversationCapabilities = {
	anchoredBatchReview: true,
	fileLevelComments: "batch",
	multiLineRanges: true,
	unresolve: true,
	reactions: ["rocket"],
	topLevelThreading: false,
	staleness: "pinned",
};
const context = { capabilities: { conversation: capabilities } };

/** A provider whose methods run the hooks a test gives them. */
function forge(
	hooks: Partial<Record<"postReview" | "reply", () => Promise<void>>> = {},
): { provider: ReviewProvider; called: string[] } {
	const called: string[] = [];
	const conversation: ConversationFacet = {
		reviews: async () => [],
		threads: async () => [],
		messages: async () => [],
		postReview: async (change) => {
			called.push(`review ${change.id}`);
			await hooks.postReview?.();
			return { id: "r1" };
		},
		reply: async (change) => {
			called.push(`reply ${change.id}`);
			await hooks.reply?.();
			return { id: "c2" };
		},
		resolve: async () => {},
		comment: async () => ({ id: "m1" }),
	};
	return {
		provider: stubProvider({
			id: "forge",
			priority: 100,
			capabilities: { conversation: capabilities },
			facets: { conversation },
		}),
		called,
	};
}

let root: string;
let deps: DraftDeps;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "review-races-"));
	deps = { store: createDraftStore(root) };
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("publishing a draft one operation at a time", () => {
	it("has put away what landed before the next operation starts", async () => {
		// A session that dies during the reply must not leave the review
		// in the store to be posted a second time on the retry.
		const draft = await openDraft(targetOf("7"), deps);
		const findingId = await draft.addFinding({ anchor, body: "leaks" });
		await draft.replyTo(thread, "context");
		let storedDuringReply: string[] | undefined;
		const { provider } = forge({
			reply: async () => {
				const stored = await deps.store.load(draft.id);
				storedDuringReply = stored?.items.map((item) => item.id);
			},
		});

		await draft.publish(draft.plan(context), provider);

		expect(storedDuringReply).toBeDefined();
		expect(storedDuringReply).not.toContain(findingId);
	});

	it("sends nothing more once it is stopped, and keeps the rest", async () => {
		const draft = await openDraft(targetOf("7"), deps);
		await draft.addFinding({ anchor, body: "leaks" });
		const replyId = await draft.replyTo(thread, "context");
		const stop = new AbortController();
		const { provider, called } = forge({
			postReview: async () => stop.abort(),
		});

		const outcome = await draft.publish(draft.plan(context), provider, {
			signal: stop.signal,
		});

		expect(called).toEqual(["review 7"]);
		expect(outcome.ok).toBe(false);
		const unsent = outcome.outcomes.filter((entry) => !entry.ok);
		expect(unsent.map((entry) => entry.error)).toEqual([
			"stopped before this was sent",
		]);
		expect(draft.state.items.map((item) => item.id)).toEqual([replyId]);
		expect((await deps.store.load(draft.id))?.items).toHaveLength(1);
	});
});

describe("publishing drafts across a stack", () => {
	it("puts away what landed in each change's draft", async () => {
		// Without this a second publish of the stack posts every review
		// again, while the answer to the first says a retry sends only
		// what is left.
		const one = await openDraft(targetOf("1"), deps);
		await one.addFinding({ anchor, body: "leaks" });
		const two = await openDraft(targetOf("2"), deps);
		await two.addFinding({ anchor, body: "races" });
		const { provider } = forge();

		const outcome = await publishAcross(
			[
				{
					ref: "base",
					change: changeOf("1"),
					plan: one.plan(context),
					draft: one,
				},
				{
					ref: "tip",
					change: changeOf("2"),
					plan: two.plan(context),
					draft: two,
				},
			],
			provider,
		);

		expect(outcome.ok).toBe(true);
		expect((await deps.store.load(one.id))?.items).toEqual([]);
		expect((await deps.store.load(two.id))?.items).toEqual([]);
	});

	it("sends nothing to the changes after it is stopped", async () => {
		const one = await openDraft(targetOf("1"), deps);
		await one.addFinding({ anchor, body: "leaks" });
		const two = await openDraft(targetOf("2"), deps);
		await two.addFinding({ anchor, body: "races" });
		const stop = new AbortController();
		const { provider, called } = forge({
			postReview: async () => stop.abort(),
		});

		const outcome = await publishAcross(
			[
				{
					ref: "base",
					change: changeOf("1"),
					plan: one.plan(context),
					draft: one,
				},
				{
					ref: "tip",
					change: changeOf("2"),
					plan: two.plan(context),
					draft: two,
				},
			],
			provider,
			{ signal: stop.signal },
		);

		expect(called).toEqual(["review 1"]);
		expect(outcome.landed).toEqual(["base"]);
		expect(outcome.remaining).toEqual(["tip"]);
		expect((await deps.store.load(two.id))?.items).toHaveLength(1);
	});
});

describe("saving a draft", () => {
	it("never shows a reader a half-written draft", async () => {
		// A reader beside a save (another call listing drafts, a second
		// session resuming one) has to find the old draft or the new one.
		// Finding neither reads as no draft at all, and a publish then
		// starts a fresh one beside it.
		const draft = await openDraft(targetOf("7"), deps);
		const big = "x".repeat(4 * 1024 * 1024);
		await draft.addFinding({ anchor, body: big });
		let missing = 0;
		let saving = true;
		const reading = (async () => {
			while (saving) {
				if ((await deps.store.load(draft.id)) === undefined) missing += 1;
			}
		})();
		for (let round = 0; round < 20; round += 1) {
			await draft.addFinding({ anchor, body: `${round}` });
		}
		saving = false;
		await reading;

		expect(missing).toBe(0);
	}, 30_000);
});

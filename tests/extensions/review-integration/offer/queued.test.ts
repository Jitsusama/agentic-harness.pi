/**
 * A change sent to a merge queue is said landed once it merges.
 *
 * On 8 November the landings record held 320 changes and not one of
 * World's, whose every merge goes through a queue (80ECO2 [a624bb26]).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rememberSession } from "../../../../extensions/review-integration/engine.ts";
import {
	noteQueued,
	QUEUED_FOR_MS,
	queuedHere,
	type Seen,
	seenOf,
	settleQueued,
} from "../../../../extensions/review-integration/queued.ts";
import {
	type BoundTarget,
	type ChangeRef,
	type ConversationFacet,
	clearReviewProviders,
	clearTargetBindings,
	createDraftStore,
	createReviewEngine,
	registerReviewProvider,
} from "../../../../lib/core/review/index.ts";
import {
	SESSION_CLOSED_CHANGE,
	SESSION_LANDED,
} from "../../../../lib/internal/session/landings.ts";
import { fakeExec } from "../../../support/fake-exec.ts";
import { stubProvider } from "../../../support/stub-provider.ts";
import {
	activate,
	HEADLESS,
	toolNamed,
} from "../../support/review-extension.ts";

const NOW = Date.parse("2026-11-09T06:00:00Z");

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "queued-"));
	vi.stubEnv("XDG_STATE_HOME", root);
	rememberSession("01a1b240-2928-74b2-80e2-553612fecd1a");
});

afterEach(() => {
	rememberSession(undefined);
	vi.unstubAllEnvs();
	clearReviewProviders();
	clearTargetBindings();
	rmSync(root, { recursive: true, force: true });
});

const change = (id: string): ChangeRef => ({
	provider: "delta",
	repo: { key: "delta:shop/world" },
	id,
	label: `shop/world#${id}`,
});

/** What a bus was told, by event. */
function bus() {
	const said: { event: string; data: unknown }[] = [];
	return {
		said,
		emit: (event: string, data: unknown) => said.push({ event, data }),
	};
}

/** A read that finds each change as `states` says, by id. */
function reading(states: Record<string, Seen | Error>) {
	return async (ref: ChangeRef): Promise<Seen> => {
		const seen = states[ref.id];
		if (seen instanceof Error) throw seen;
		return seen ?? null;
	};
}

const open: Seen = { state: "open", title: "Open", url: "https://d/1" };

describe("a change sent to a queue", () => {
	it("is kept once, however often it is sent, with the line its merge carried", () => {
		noteQueued(change("1"), undefined, NOW);
		noteQueued(change("1"), "Try it now.", NOW);

		expect(queuedHere()).toEqual([
			{
				change: change("1"),
				since: new Date(NOW).toISOString(),
				person: "Try it now.",
			},
		]);
	});

	it("is said landed once it merges, by its title and page, and let go", async () => {
		const told = bus();
		noteQueued(change("2399124"), "Nothing to try.", NOW);

		await settleQueued(
			reading({
				"2399124": {
					state: "merged",
					title: "Delete Unread Settings",
					url: "https://delta.example/shop/world/pull/2399124",
					mergeCommit: "9c0ffee1",
					base: "main",
				},
			}),
			told,
			NOW,
		);

		expect(told.said).toEqual([
			{
				event: SESSION_LANDED,
				data: expect.objectContaining({
					ref: "world#2399124",
					what: "Delete Unread Settings",
					url: "https://delta.example/shop/world/pull/2399124",
					person: "Nothing to try.",
					commit: "9c0ffee1",
					onto: "main",
				}),
			},
		]);
		expect(queuedHere()).toEqual([]);
	});

	it("says the areas its files are in once it merges", async () => {
		const told = bus();
		noteQueued(change("5"), undefined, NOW);

		await settleQueued(
			reading({
				"5": {
					state: "merged",
					title: "Five",
					url: "https://d/5",
					files: ["lib/mesh/peer.ts", "lib/mesh/presence.ts"],
				},
			}),
			told,
			NOW,
		);

		expect(told.said).toEqual([
			{
				event: SESSION_LANDED,
				data: expect.objectContaining({ areas: ["lib/mesh"] }),
			},
		]);
	});

	it("is said closed once it closes unmerged, and let go", async () => {
		const told = bus();
		noteQueued(change("3"), undefined, NOW);

		await settleQueued(
			reading({ "3": { state: "closed", title: "Gone", url: "https://d/3" } }),
			told,
			NOW,
		);

		expect(told.said).toEqual([
			{ event: SESSION_CLOSED_CHANGE, data: { url: "https://d/3" } },
		]);
		expect(queuedHere()).toEqual([]);
	});

	it("is kept while it waits or can't be read, and let go unsaid after a week", async () => {
		const told = bus();
		noteQueued(change("4"), undefined, NOW);
		noteQueued(change("5"), undefined, NOW);
		noteQueued(change("6"), undefined, NOW - QUEUED_FOR_MS - 1);

		await settleQueued(
			reading({ "4": open, "5": new Error("host down"), "6": open }),
			told,
			NOW,
		);

		expect(told.said).toEqual([]);
		expect(queuedHere().map((one) => one.change.id)).toEqual(["4", "5"]);
	});
});

describe("what sends a change to the queue", () => {
	/** A Delta host whose comments are recorded. */
	function delta(said: string[]): void {
		const unused = async (): Promise<never> => {
			throw new Error("this test never asks for that");
		};
		const conversation: ConversationFacet = {
			reviews: unused,
			threads: async () => [],
			messages: async () => [],
			postReview: unused,
			reply: unused,
			resolve: unused,
			comment: async (_ref: ChangeRef, body: string) => {
				said.push(body);
				return {};
			},
		};
		registerReviewProvider(
			stubProvider({
				id: "delta",
				priority: 40,
				claimReference: (input) => {
					const id = /\/pull\/(\d+)$/.exec(input)?.[1];
					return id === undefined ? null : change(id);
				},
				facets: { conversation },
			}),
		);
	}

	it("is a /merge comment, which is watched until it lands; any other comment isn't", async () => {
		const said: string[] = [];
		delta(said);
		const say = toolNamed(activate(), "review_say");
		const comment = (url: string, body: string) =>
			say.execute(
				"comment",
				{ action: "comment", change: url, body },
				undefined,
				undefined,
				HEADLESS,
			);

		await comment("https://delta.example/shop/world/pull/7", "/merge");
		await comment("https://delta.example/shop/world/pull/8", "Looks good.");

		expect(said).toEqual(["/merge", "Looks good."]);
		expect(queuedHere().map((one) => one.change.label)).toEqual([
			"shop/world#7",
		]);
	});
});

/**
 * A change bound over a provider that finds it in `state` and diffs it
 * as `diff` says, its every diff and fetch into a checkout counted.
 */
async function boundIn(
	state: "open" | "merged",
	diff: string | Error,
): Promise<{ bound: BoundTarget; asked: string[] }> {
	const asked: string[] = [];
	const repo = { key: "delta:shop/world", localPath: root };
	registerReviewProvider(
		stubProvider({
			id: "delta",
			priority: 1,
			facets: {
				changes: {
					fetch: async (ref) => ({
						ref,
						title: "Delete Unread Settings",
						body: "",
						state,
						draft: false,
						author: { id: "someone" },
						base: "main",
						head: "feature",
						url: "https://delta.example/shop/world/pull/9",
					}),
					diff: async () => {
						asked.push("diff");
						if (diff instanceof Error) throw diff;
						return diff;
					},
					fetchAsRef: async () => {
						asked.push("fetch into the checkout");
						return "refs/fetched";
					},
				},
			},
		}),
	);
	const { exec } = fakeExec([]);
	const engine = createReviewEngine({ exec, store: createDraftStore(root) });
	return { bound: await engine.bound({ ...change("9"), repo }), asked };
}

describe("a look at a queued change", () => {
	it("finds the paths a merged change touched, from its diff", async () => {
		const { bound } = await boundIn(
			"merged",
			"diff --git a/lib/mesh/peer.ts b/lib/mesh/peer.ts\n--- a/lib/mesh/peer.ts\n+++ b/lib/mesh/peer.ts\n@@ -1 +1 @@\n-a\n+b\n",
		);

		expect((await seenOf(bound))?.files).toEqual(["lib/mesh/peer.ts"]);
	});

	it("never diffs a change still queued", async () => {
		const { bound, asked } = await boundIn("open", "");

		const seen = await seenOf(bound);

		expect(seen?.state).toBe("open");
		expect(asked).toEqual([]);
	});

	// The engine's fallback for a refused diff fetches into the checkout
	// and diffs against a local base that may be stale.
	it("finds no paths, fetching nothing, when its backend refuses the diff", async () => {
		const { bound, asked } = await boundIn(
			"merged",
			new Error("HTTP 406: the diff exceeded the maximum number of lines"),
		);

		const seen = await seenOf(bound);

		expect(seen?.state).toBe("merged");
		expect(seen).not.toHaveProperty("files");
		expect(asked).toEqual(["diff"]);
	});
});

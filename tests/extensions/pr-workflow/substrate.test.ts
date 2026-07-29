/**
 * The consumer end of the substrate handshake.
 *
 * This workflow does not host the substrate, it borrows one. That
 * makes two things worth pinning: that it finds the host whatever
 * order the two extensions loaded in, and that it says something
 * useful when there is no host to find.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
	claimedByAnotherSystem,
	diffFromSubstrate,
	forgetSubstrate,
	headCommitFromSubstrate,
	postReviewThroughSubstrate,
	replyThroughSubstrate,
	repoForBareChange,
	resolveThroughSubstrate,
	setSubstrateApi,
	threadsFromSubstrate,
} from "../../../extensions/pr-workflow/substrate.js";
import type {
	BoundTarget,
	ConversationFacet,
	Message,
	Proposal,
	ReviewEngine,
	ReviewSubstrateApi,
	Thread,
	WireReview,
} from "../../../lib/review/index.js";

const reference = { owner: "o", repo: "r", number: 7 };

/** A substrate whose engine resolves to the conversation given. */
function substrate(
	conversation: ConversationFacet | null,
	proposal: Partial<Proposal> | null = null,
	diff = "",
): {
	api: ReviewSubstrateApi;
	resolved: string[];
} {
	const resolved: string[] = [];
	const engine = {
		async resolve(input: string) {
			resolved.push(input);
			return {
				target: {
					kind: "proposal",
					change: {
						provider: "github",
						repo: { key: "github:o/r" },
						id: "7",
						label: "o/r#7",
					},
				},
				conversation,
				proposal: async () => proposal,
				diff: async () => diff,
			} as unknown as BoundTarget;
		},
	} as unknown as ReviewEngine;
	const api = {
		registerProvider() {},
		listProviders: () => ["github"],
		engine: async () => engine,
	} satisfies ReviewSubstrateApi;
	return { api, resolved };
}

/** A conversation facet answering with fixed records. */
function facet(threads: Thread[], messages: Message[]): ConversationFacet {
	return {
		threads: async () => threads,
		messages: async () => messages,
	} as unknown as ConversationFacet;
}

afterEach(() => forgetSubstrate());

describe("replyThroughSubstrate", () => {
	const thread: Thread = {
		id: "PRRT_1",
		resolved: false,
		comments: [{ id: "c1", author: { id: "octocat" }, body: "hi" }],
	};

	/** A facet that records what it was asked to reply to. */
	function replying(): {
		conversation: ConversationFacet;
		sent: { thread: Thread; body: string }[];
	} {
		const sent: { thread: Thread; body: string }[] = [];
		const conversation = {
			threads: async () => [thread],
			messages: async () => [],
			async reply(_ref: unknown, target: Thread, body: string) {
				sent.push({ thread: target, body });
				return { url: "https://github.com/o/r/pull/7#c9" };
			},
		} as unknown as ConversationFacet;
		return { conversation, sent };
	}

	it("hands the provider the whole record and returns the new comment's url", async () => {
		const { conversation, sent } = replying();
		const { api } = substrate(conversation);
		setSubstrateApi(api);
		const [view] = await threadsFromSubstrate(reference);

		const url = await replyThroughSubstrate(reference, view, "seems fine");

		expect(sent).toEqual([{ thread, body: "seems fine" }]);
		expect(url).toBe("https://github.com/o/r/pull/7#c9");
	});

	it("refuses a view that carries no record rather than guessing one", async () => {
		// A snapshot restored from an older session predates the
		// record being kept. Inventing a Thread from the id would
		// work on GitHub and silently address the wrong comment
		// somewhere else.
		const { conversation } = replying();
		const { api } = substrate(conversation);
		setSubstrateApi(api);

		await expect(
			replyThroughSubstrate(
				reference,
				{
					id: "PRRT_1",
					kind: "review-thread",
					isResolved: false,
					isOutdated: false,
					path: null,
					line: null,
					comments: [],
				},
				"seems fine",
			),
		).rejects.toThrow(/refresh|action=threads/i);
	});
});

describe("repoForBareChange", () => {
	it("asks the substrate which repo a bare number means here", async () => {
		// The resolver knows about config mappings and provider
		// claims. Reading the origin remote directly would ignore
		// both and be wrong in exactly the repos that configured one.
		const { api, resolved } = substrate(null);
		setSubstrateApi(api);

		expect(await repoForBareChange("123")).toEqual({
			owner: "o",
			repo: "r",
		});
		expect(resolved).toEqual(["123"]);
	});

	it("answers nothing when there is no substrate to ask", async () => {
		// Load has its own message for an unresolvable reference, and
		// it reads better than a substrate error the user cannot act
		// on while typing a PR number.
		forgetSubstrate();

		expect(await repoForBareChange("123")).toBeNull();
	});

	it("answers nothing when the reference resolves nowhere", async () => {
		const api = {
			registerProvider() {},
			listProviders: () => ["github"],
			engine: async () =>
				({
					async resolve() {
						throw new Error("nothing claims this");
					},
				}) as unknown as ReviewEngine,
		} satisfies ReviewSubstrateApi;
		setSubstrateApi(api);

		expect(await repoForBareChange("123")).toBeNull();
	});
});

describe("diffFromSubstrate", () => {
	it("hands back the diff the provider produced, unchanged", async () => {
		// Whoever reads this parses it, so a stray transformation here
		// would move a bug somewhere much harder to see.
		const patch = "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
		setSubstrateApi(substrate(null, null, patch).api);

		expect(await diffFromSubstrate(reference)).toBe(patch);
	});

	it("resolves the change by the name a person would write", async () => {
		const { api, resolved } = substrate(null, null, "");
		setSubstrateApi(api);

		await diffFromSubstrate(reference);

		expect(resolved).toEqual(["o/r#7"]);
	});
});

describe("postReviewThroughSubstrate", () => {
	/** A facet that records the review it was handed. */
	function posting(): { conversation: ConversationFacet; sent: WireReview[] } {
		const sent: WireReview[] = [];
		const conversation = {
			async postReview(_ref: unknown, review: WireReview) {
				sent.push(review);
				return { url: "https://example.test/r/1" };
			},
		} as unknown as ConversationFacet;
		return { conversation, sent };
	}

	it("says each GitHub event as the verdict the contract knows", async () => {
		const { conversation, sent } = posting();
		setSubstrateApi(substrate(conversation).api);

		for (const event of ["APPROVE", "REQUEST_CHANGES", "COMMENT"] as const) {
			await postReviewThroughSubstrate({
				ref: reference,
				event,
				body: "looks good",
				comments: [],
			});
		}

		expect(sent.map((r) => r.verdict)).toEqual([
			"approve",
			"request-changes",
			"comment",
		]);
	});

	it("anchors a single-line comment on the side it was written against", async () => {
		const { conversation, sent } = posting();
		setSubstrateApi(substrate(conversation).api);

		await postReviewThroughSubstrate({
			ref: reference,
			event: "COMMENT",
			body: "",
			comments: [{ path: "a.ts", line: 12, body: "here" }],
		});

		expect(sent[0].comments).toEqual([
			{
				anchor: { subject: "line", path: "a.ts", blob: "new", line: 12 },
				body: "here",
			},
		]);
	});

	it("keeps a multi-line range together", async () => {
		const { conversation, sent } = posting();
		setSubstrateApi(substrate(conversation).api);

		await postReviewThroughSubstrate({
			ref: reference,
			event: "COMMENT",
			body: "",
			comments: [{ path: "a.ts", line: 20, startLine: 15, body: "span" }],
		});

		expect(sent[0].comments[0].anchor).toEqual({
			subject: "line",
			path: "a.ts",
			blob: "new",
			line: 20,
			startLine: 15,
		});
	});

	it("carries a comment written against the old side", async () => {
		// A remark on a deleted line belongs on the left, and posting
		// it against the right would attach it to unrelated code.
		const { conversation, sent } = posting();
		setSubstrateApi(substrate(conversation).api);

		await postReviewThroughSubstrate({
			ref: reference,
			event: "COMMENT",
			body: "",
			comments: [{ path: "a.ts", line: 4, side: "LEFT", body: "gone" }],
		});

		expect(sent[0].comments[0].anchor).toMatchObject({ blob: "old" });
	});

	it("refuses when nothing hosts the change", async () => {
		// Posting is not best-effort. A review that silently went
		// nowhere is worse than one that failed loudly.
		setSubstrateApi(substrate(null).api);

		await expect(
			postReviewThroughSubstrate({
				ref: reference,
				event: "COMMENT",
				body: "x",
				comments: [],
			}),
		).rejects.toThrow(/o\/r#7/);
	});
});

describe("headCommitFromSubstrate", () => {
	it("reads the tip the proposal already reports", async () => {
		const { api } = substrate(null, { headCommit: "abc1234" });
		setSubstrateApi(api);

		expect(await headCommitFromSubstrate(reference)).toBe("abc1234");
	});

	it("answers nothing when the provider withholds the tip", async () => {
		// The drift check compares against what it last saw, and an
		// absent answer has to read as unknown rather than as moved.
		const { api } = substrate(null, { headCommit: undefined });
		setSubstrateApi(api);

		expect(await headCommitFromSubstrate(reference)).toBeUndefined();
	});

	it("answers nothing when nothing hosts the change", async () => {
		// A local range has no proposal behind it, and that is not a
		// failure worth throwing at a drift check.
		const { api } = substrate(null, null);
		setSubstrateApi(api);

		expect(await headCommitFromSubstrate(reference)).toBeUndefined();
	});
});

describe("resolveThroughSubstrate", () => {
	const thread: Thread = {
		id: "PRRT_1",
		resolved: false,
		comments: [{ id: "c1", author: { id: "octocat" }, body: "hi" }],
	};

	function resolving(): {
		conversation: ConversationFacet;
		closed: Thread[];
	} {
		const closed: Thread[] = [];
		const conversation = {
			threads: async () => [thread],
			messages: async () => [],
			async resolve(_ref: unknown, target: Thread) {
				closed.push(target);
			},
		} as unknown as ConversationFacet;
		return { conversation, closed };
	}

	it("hands the provider the whole record and reports it resolved", async () => {
		// The facet answers by completing rather than by returning a
		// state, and completing is the provider saying it is done.
		const { conversation, closed } = resolving();
		const { api } = substrate(conversation);
		setSubstrateApi(api);
		const [view] = await threadsFromSubstrate(reference);

		const isResolved = await resolveThroughSubstrate(reference, view);

		expect(closed).toEqual([thread]);
		expect(isResolved).toBe(true);
	});

	it("refuses a view that carries no record", async () => {
		const { api } = substrate(resolving().conversation);
		setSubstrateApi(api);

		await expect(
			resolveThroughSubstrate(reference, {
				id: "PRRT_1",
				kind: "review-thread",
				isResolved: false,
				isOutdated: false,
				path: null,
				line: null,
				comments: [],
			}),
		).rejects.toThrow(/refresh|action=threads/i);
	});
});

describe("threadsFromSubstrate", () => {
	it("reads the conversation of whichever provider claimed the change", async () => {
		const conversation = facet(
			[{ id: "PRRT_1", resolved: false, comments: [] }],
			[{ id: "m1", author: { id: "octocat" }, body: "hello" }],
		);
		const { api, resolved } = substrate(conversation);
		setSubstrateApi(api);

		const view = await threadsFromSubstrate(reference);

		expect(resolved).toEqual(["o/r#7"]);
		expect(view.map((entry) => [entry.id, entry.kind])).toEqual([
			["PRRT_1", "review-thread"],
			["m1", "review-level"],
		]);
	});

	it("says what is missing when no substrate ever announced itself", async () => {
		// The likely cause is that the host extension is not
		// installed, and a bare undefined would send the reader
		// looking in the wrong place.
		await expect(threadsFromSubstrate(reference)).rejects.toThrow(
			/review-integration/i,
		);
	});

	it("keeps the record each view was projected from", async () => {
		// A write is keyed by the whole record, because one backend
		// keys a reply by the thread and another by the comment that
		// started it. Projecting the record away would strand the
		// write with only the half GitHub happens to use.
		const thread: Thread = {
			id: "PRRT_1",
			resolved: false,
			comments: [{ id: "c1", author: { id: "octocat" }, body: "hi" }],
		};
		const { api } = substrate(facet([thread], []));
		setSubstrateApi(api);

		const [view] = await threadsFromSubstrate(reference);

		expect(view.source).toEqual(thread);
	});

	it("names the change when nothing hosts a conversation for it", async () => {
		// A local checkout resolves fine and has no conversation at
		// all. That is a legitimate target, not a broken one.
		const { api } = substrate(null);
		setSubstrateApi(api);

		await expect(threadsFromSubstrate(reference)).rejects.toThrow(/o\/r#7/);
	});
});

describe("claimedByAnotherSystem", () => {
	/** A substrate whose engine resolves to the provider given. */
	function claiming(provider: string, label: string): ReviewSubstrateApi {
		const engine = {
			async resolve() {
				return {
					target: {
						kind: "proposal",
						change: {
							provider,
							repo: { key: `${provider}:shop/world` },
							id: "2000970",
							label,
						},
					},
				} as unknown as BoundTarget;
			},
		} as unknown as ReviewEngine;
		return {
			registerProvider() {},
			listProviders: () => [provider],
			engine: async () => engine,
		};
	}

	it("names the system that claimed the reference", async () => {
		// Reporting this as unparseable would be a lie. The reference
		// was understood perfectly; it just belongs to a system this
		// workflow cannot drive yet.
		setSubstrateApi(claiming("meteorite", "shop/world#2000970"));

		expect(await claimedByAnotherSystem("2000970")).toEqual({
			provider: "meteorite",
			label: "shop/world#2000970",
		});
	});

	it("says nothing about a reference GitHub claimed", async () => {
		// This workflow serves GitHub, so there is nothing to warn
		// about and nothing to get in the way.
		const { api } = substrate(null);
		setSubstrateApi(api);

		expect(await claimedByAnotherSystem("7")).toBeNull();
	});

	it("says nothing when there is no substrate to ask", async () => {
		// Without the host extension there is no second opinion to
		// offer, and the ordinary parse message is the right one.
		forgetSubstrate();

		expect(await claimedByAnotherSystem("2000970")).toBeNull();
	});

	it("says nothing when the reference resolves nowhere", async () => {
		// An unresolvable reference is what the parse message already
		// covers, and guessing a system for it would mislead.
		setSubstrateApi({
			registerProvider() {},
			listProviders: () => ["github"],
			engine: async () =>
				({
					async resolve() {
						throw new Error("nothing claimed it");
					},
				}) as unknown as ReviewEngine,
		});

		expect(await claimedByAnotherSystem("2000970")).toBeNull();
	});
});

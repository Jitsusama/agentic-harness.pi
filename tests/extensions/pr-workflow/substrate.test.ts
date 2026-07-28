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
	forgetSubstrate,
	headCommitFromSubstrate,
	replyThroughSubstrate,
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
} from "../../../lib/review/index.js";

const reference = { owner: "o", repo: "r", number: 7 };

/** A substrate whose engine resolves to the conversation given. */
function substrate(
	conversation: ConversationFacet | null,
	proposal: Partial<Proposal> | null = null,
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

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
	setSubstrateApi,
	threadsFromSubstrate,
} from "../../../extensions/pr-workflow/substrate.js";
import type {
	BoundTarget,
	ConversationFacet,
	Message,
	ReviewEngine,
	ReviewSubstrateApi,
	Thread,
} from "../../../lib/review/index.js";

const reference = { owner: "o", repo: "r", number: 7 };

/** A substrate whose engine resolves to the conversation given. */
function substrate(conversation: ConversationFacet | null): {
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

	it("names the change when nothing hosts a conversation for it", async () => {
		// A local checkout resolves fine and has no conversation at
		// all. That is a legitimate target, not a broken one.
		const { api } = substrate(null);
		setSubstrateApi(api);

		await expect(threadsFromSubstrate(reference)).rejects.toThrow(/o\/r#7/);
	});
});

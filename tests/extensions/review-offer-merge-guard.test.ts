/**
 * V19 of the validation plan: what a refused head guard says.
 *
 * `expectedHead` is the only guard against merging work nobody looked at, so
 * it fires on the day somebody pushed while you were reading. What it said
 * was GitHub's own words, "Head branch was modified", passed through.
 *
 * Those words name a cause, and the cause is often false. Both times the
 * guard fired during this quest the branch had not been touched: the
 * expectation was wrong, completed from an eight-character prefix rather than
 * read. The message sends the reader looking for a push that never happened,
 * and the one fact that would end the search, which head the change is
 * actually at, is known here and was not being said.
 */

import {
	type AuthoringCapabilities,
	clearReviewProviders,
	clearTargetBindings,
	type Proposal,
	registerReviewProvider,
} from "@jitsusama/agentic-harness.core/review";
import { afterEach, describe, expect, it } from "vitest";
import { stubProvider } from "../support/stub-provider.js";
import { activate, HEADLESS, toolNamed } from "./support/review-extension.js";

const AT = "b8210c7420448a5390ca3b2d8bc65c5ceab2af0f";
const CLAIMED = "b8210c7409c9c25e5c62ac0cbe0d84d8c2ea0d33";

const CAN_MERGE: AuthoringCapabilities = {
	propose: false,
	proposeStack: false,
	reviewersAt: "never",
	retarget: "never",
	setDraft: false,
	close: false,
	reopen: false,
	merge: true,
	labels: false,
	assignees: false,
	identifies: "login",
	rerunChecks: false,
	refusesWhileEnqueued: false,
};

const unused = (method: string) => async (): Promise<never> => {
	throw new Error(`this test never asks a provider to ${method}`);
};

/**
 * The change as the backend reports it, sitting at a known head.
 *
 * Named against a stub provider rather than `github`, because `activate()`
 * registers the extension's real providers into the same process-wide
 * registry and a stub sharing an id is silently replaced by one that talks to
 * the network.
 */
const proposal: Proposal = {
	ref: {
		provider: "meteorite",
		repo: { key: "meteorite:shop/world" },
		id: "438",
		label: "shop/world#438",
	},
	title: "Make a Panel Cover What It Is Drawn Over",
	body: "### 🌐 Situation\n\nIt did not.\n",
	state: "open",
	draft: false,
	author: { id: "Jitsusama" },
	base: "main",
	head: "jitsusama/validate-pr-arc",
	headCommit: AT,
	url: "https://example.invalid/438",
};

/** A backend that merges, and records whether it was ever asked to. */
function mergingProvider() {
	const merges: unknown[] = [];
	const provider = stubProvider({
		id: "meteorite",
		priority: 50,
		claimRepo: () => ({ key: "meteorite:shop/world" }),
		claimReference: (input) => ({
			provider: "meteorite",
			repo: { key: "meteorite:shop/world" },
			id: input,
			label: `shop/world#${input}`,
		}),
		capabilities: { authoring: CAN_MERGE },
		facets: {
			proposals: {
				fetch: async () => proposal,
				diff: unused("diff a change"),
			},
			authoring: {
				propose: unused("propose a change"),
				edit: unused("edit a change"),
				close: unused("close a change"),
				merge: async (_change: unknown, request: unknown) => {
					merges.push(request);
					return { kind: "merged" as const, commit: "deadbeefcafe" };
				},
			},
		},
	});
	return { provider, merges };
}

async function offer(params: Record<string, unknown>) {
	const stub = activate();
	const tool = toolNamed(stub, "review_offer");
	return await tool.execute("1", params, undefined, undefined, HEADLESS);
}

afterEach(() => {
	clearReviewProviders();
	clearTargetBindings();
});

describe("merging behind a head guard", () => {
	it("names both heads when the expectation does not match", async () => {
		const { provider, merges } = mergingProvider();
		registerReviewProvider(provider);

		const answer = await offer({
			action: "merge",
			change: "438",
			expectedHead: CLAIMED,
		});

		const said = JSON.stringify(answer);
		// The head asked for and the head it is at, both said, so the reader
		// can see at a glance that the two share a prefix and diverge after it.
		expect(said).toContain(CLAIMED);
		expect(said).toContain(AT);
		// And nothing is merged on the strength of a stale expectation.
		expect(merges).toEqual([]);
	});

	it("merges when the expectation matches", async () => {
		const { provider, merges } = mergingProvider();
		registerReviewProvider(provider);

		await offer({
			action: "merge",
			change: "438",
			expectedHead: AT,
		});

		expect(merges).toHaveLength(1);
	});

	it("still merges when no expectation is given", async () => {
		const { provider, merges } = mergingProvider();
		registerReviewProvider(provider);

		await offer({
			action: "merge",
			change: "438",
		});

		expect(merges).toHaveLength(1);
	});
});

/**
 * Merging is the moment a change stops being in play.
 *
 * Nothing said so, so an attachment outlived the change it named and
 * every later call still preferred it. A session that had shipped
 * eight changes was carrying eight of them, and each one hijacked the
 * calls whose subject is a repo: naming a checkout was answered with
 * "the change in play is on ..." eight times over, once per pop.
 *
 * Enqueuing is deliberately not the same event. A queued change has
 * been accepted for a batch that may still fail, which is precisely
 * the state in which it is still yours to watch.
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

/** A backend whose merge lands, or is taken into a queue. */
function backend(outcome: { kind: "merged" | "enqueued" }) {
	return stubProvider({
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
				merge: async () =>
					outcome.kind === "merged"
						? { kind: "merged" as const, commit: "deadbeefcafe" }
						: { kind: "enqueued" as const },
			},
		},
	});
}

/** Attach 438, then merge it, and report what is left attached. */
async function attachThenMerge(outcome: { kind: "merged" | "enqueued" }) {
	registerReviewProvider(backend(outcome));
	const stub = activate();
	const review = toolNamed(stub, "review");
	const offer = toolNamed(stub, "review_offer");

	await review.execute(
		"attach",
		{ action: "attach", change: "438" },
		undefined,
		undefined,
		HEADLESS,
	);
	const merged = await offer.execute(
		"merge",
		{ action: "merge", change: "438" },
		undefined,
		undefined,
		HEADLESS,
	);
	const listed = await review.execute(
		"list",
		{},
		undefined,
		undefined,
		HEADLESS,
	);
	return { merged: JSON.stringify(merged), listed: JSON.stringify(listed) };
}

afterEach(() => {
	clearReviewProviders();
	clearTargetBindings();
});

describe("what merging does to the attachment", () => {
	it("lets the change go once it has landed", async () => {
		const { listed } = await attachThenMerge({ kind: "merged" });

		expect(listed).not.toContain("shop/world#438");
	});

	it("says so, rather than letting it be discovered", async () => {
		// A registry cleared in silence is the thing that makes the next
		// refusal unreadable.
		const { merged } = await attachThenMerge({ kind: "merged" });

		expect(merged).toContain("etached");
	});

	it("keeps a change the queue has only accepted", async () => {
		// It lands when the queue reaches it, and not at all if its checks
		// fail, so it is still the thing being watched.
		const { listed } = await attachThenMerge({ kind: "enqueued" });

		expect(listed).toContain("shop/world#438");
	});
});

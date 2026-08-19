/**
 * Proposing a stack, with something in each body.
 *
 * Every change in a stack was created with `body: ""`, so the one path
 * built for stacks could not produce a body the PR format accepts. The
 * way out was to propose each change on its own and then edit it, which
 * is what turned four changes into seven gated calls.
 *
 * Bodies are positional, aligned to `heads`, because `heads` is already
 * positional and already carries the dependency order. A length mismatch
 * is refused rather than paired off silently: quietly dropping the last
 * body would put the wrong text on a change nobody reread.
 */

import {
	type AuthoringCapabilities,
	clearReviewProviders,
	clearTargetBindings,
	type Proposal,
	type ProposalDraft,
	type RepoLocator,
	registerReviewProvider,
} from "@jitsusama/agentic-harness.core/review";
import { afterEach, describe, expect, it } from "vitest";
import { stubProvider } from "../support/stub-provider.js";
import { activate, HEADLESS, toolNamed } from "./support/review-extension.js";

const world: RepoLocator = { key: "meteorite:shop/world" };

const CAN_STACK: AuthoringCapabilities = {
	propose: true,
	proposeStack: true,
	reviewersAt: "never",
	retarget: "stack",
	setDraft: false,
	close: false,
	reopen: false,
	merge: false,
	labels: false,
	assignees: false,
	identifies: "email",
	rerunChecks: false,
	refusesWhileEnqueued: false,
};

/** A body shaped the way the PR format requires. */
function bodyFor(what: string): string {
	return [
		"### 🌐 Situation",
		"",
		`${what} was missing.`,
		"",
		"### 🔧 Resolution",
		"",
		`Added ${what}.`,
		"",
		"### 🔬 Validation",
		"",
		"A test.",
	].join("\n");
}

const unused = (method: string) => async (): Promise<never> => {
	throw new Error(`this test never asks a provider to ${method}`);
};

/** A provider that records the drafts it was asked to open. */
function recordingProvider(options: { editFails?: boolean } = {}) {
	const asked: ProposalDraft[][] = [];
	const edits: { id: string; body?: string }[] = [];
	const provider = stubProvider({
		id: "meteorite",
		priority: 50,
		claimRepo: () => world,
		capabilities: { authoring: CAN_STACK },
		facets: {
			authoring: {
				propose: unused("propose one change"),
				close: unused("close a change"),
				merge: unused("merge a change"),
				edit: async (ref, edit) => {
					if (options.editFails) throw new Error("the server said no");
					edits.push({
						id: ref.id,
						...(edit.body?.action === "set" ? { body: edit.body.value } : {}),
					});
					return madeFrom(ref.id, "");
				},
				proposeStack: async (drafts: ProposalDraft[]): Promise<Proposal[]> => {
					asked.push(drafts);
					return drafts.map((draft, at) =>
						madeFrom(String(at + 1), draft.head),
					);
				},
			},
		},
	});
	return { provider, asked, edits };
}

/** A proposal as a backend would answer with one. */
function madeFrom(id: string, head: string): Proposal {
	return {
		ref: {
			provider: "meteorite",
			repo: world,
			id,
			label: `shop/world#${id}`,
		},
		title: head || "something",
		body: "",
		state: "open",
		draft: true,
		author: { id: "joel.gerber@shopify.com" },
		base: "main",
		head: head || "topic",
	};
}

async function offer(params: Record<string, unknown>) {
	// A stack reads each branch's tip subject to title the change, so the
	// checkout has to answer that much or every branch reads as absent.
	const stub = activate({ "log -1 --format=%s": { stdout: "A Tip Subject" } });
	const tool = toolNamed(stub, "review_offer");
	return await tool.execute("1", params, undefined, undefined, HEADLESS);
}

const stack = {
	action: "propose-stack",
	draft: true,
	base: "main",
	heads: ["one", "two"],
};

afterEach(() => {
	clearReviewProviders();
	clearTargetBindings();
});

describe("proposing a stack with bodies", () => {
	it("gives each change the body aligned to its branch", async () => {
		const { provider, asked } = recordingProvider();
		registerReviewProvider(provider);

		await offer({
			...stack,
			bodies: [bodyFor("the first thing"), bodyFor("the second thing")],
		});

		expect(asked).toHaveLength(1);
		expect(asked[0]?.[0]?.body).toContain("the first thing");
		expect(asked[0]?.[1]?.body).toContain("the second thing");
	});

	it("refuses when the counts disagree, rather than pairing what it can", async () => {
		const { provider, asked } = recordingProvider();
		registerReviewProvider(provider);

		const answer = await offer({ ...stack, bodies: [bodyFor("only one")] });

		expect(asked).toHaveLength(0);
		expect(JSON.stringify(answer)).toMatch(
			/2 branches|1 body|disagree|as many/i,
		);
	});

	it("holds every body to the conventions, not just the first", async () => {
		const { provider, asked } = recordingProvider();
		registerReviewProvider(provider);

		const answer = await offer({
			...stack,
			bodies: [bodyFor("the first thing"), "### 📝 Notes\n\nWrong sections."],
		});

		expect(asked).toHaveLength(0);
		expect(JSON.stringify(answer)).toContain("github-pr-format");
	});

	it("writes the stack note into each body once every number exists", async () => {
		// This is the only place every number is known at once. Left to the
		// caller it is N-1 edits they have to remember, which is what turned
		// four changes into seven gated calls.
		const { provider, edits } = recordingProvider();
		registerReviewProvider(provider);

		await offer({
			...stack,
			bodies: [bodyFor("the first thing"), bodyFor("the second thing")],
		});

		expect(edits).toHaveLength(2);
		// The bottom change has nothing below it and the top nothing above,
		// so each keeps only the segments that point somewhere.
		const bottom = edits.find((one) => one.id === "1")?.body ?? "";
		const top = edits.find((one) => one.id === "2")?.body ?? "";
		expect(bottom).toContain("shop/world#2");
		expect(bottom).not.toContain("\ud83d\udc48");
		expect(top).toContain("shop/world#1");
		expect(top).not.toContain("\ud83d\udc49");
	});

	it("keeps the changes when writing the notes fails", async () => {
		// The stack is up by then. Reporting a bare failure describes a world
		// where it is not, and the obvious response to that is to propose it
		// again.
		const { provider } = recordingProvider({ editFails: true });
		registerReviewProvider(provider);

		const answer = await offer({
			...stack,
			bodies: [bodyFor("the first thing"), bodyFor("the second thing")],
		});
		const text = JSON.stringify(answer);

		expect(text).toContain("shop/world#1");
		expect(text).toContain("shop/world#2");
		expect(text).toMatch(/note/i);
	});

	it("writes no note for a stack of one, since there is nothing to point at", async () => {
		const { provider, edits } = recordingProvider();
		registerReviewProvider(provider);

		await offer({
			action: "propose-stack",
			draft: true,
			base: "main",
			heads: ["one", "two"],
			bodies: [bodyFor("a"), bodyFor("b")],
		});

		// Two changes, so notes. The one-change case cannot reach here: a
		// stack of one is refused before anything is proposed.
		expect(edits).toHaveLength(2);
	});

	it("still proposes a stack with no bodies at all", async () => {
		// Bodies are optional: a stack of small changes whose subjects say
		// everything is a fair thing to propose.
		const { provider, asked } = recordingProvider();
		registerReviewProvider(provider);

		await offer(stack);

		expect(asked).toHaveLength(1);
		expect(asked[0]).toHaveLength(2);
	});
});

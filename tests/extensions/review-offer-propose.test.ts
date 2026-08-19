/**
 * What the propose path actually hands the provider.
 *
 * A unit test over the binding proves a resolution reports the right
 * repo. It cannot prove the tool passes that repo to the backend, and
 * the session this came from failed in the gap between the two: the
 * first propose worked, a convention gate refused the second for its
 * title, and every attempt after that was refused by the provider
 * instead, because it was being handed a `local:` key it does not serve.
 * Four refusals in, the changes were cut by hand.
 *
 * So the assertion here is the one that matters: the repo the provider
 * receives, on the first call and on the retry. No backend is involved.
 * The stub provider records what it was asked for, and the gate approves
 * itself because a headless context has nothing to draw on.
 */

import {
	type AuthoringCapabilities,
	clearReviewProviders,
	clearTargetBindings,
	type Proposal,
	type RepoLocator,
	registerReviewProvider,
} from "@jitsusama/agentic-harness.core/review";
import { afterEach, describe, expect, it } from "vitest";
import { stubProvider } from "../support/stub-provider.js";
import { activate, HEADLESS, toolNamed } from "./support/review-extension.js";

/** The hosted repo the checkout maps onto, as a provider would claim it. */
const world: RepoLocator = { key: "meteorite:shop/world" };

/** A body that satisfies the PR section conventions. */
const BODY = [
	"### 🌐 Situation",
	"",
	"The binding remembered too little.",
	"",
	"### 🔧 Resolution",
	"",
	"It remembers the whole resolution now.",
	"",
	"### 🔬 Validation",
	"",
	"This test.",
].join("\n");

/**
 * A backend that can only open a change. Declared in full rather than
 * cast, because the tool asks these before it asks anything of the
 * facet, and a stub that overstates them would be answering a question
 * a real provider answers differently.
 */
const CAN_ONLY_PROPOSE: AuthoringCapabilities = {
	propose: true,
	proposeStack: false,
	reviewersAt: "never",
	retarget: "never",
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

/**
 * The facet's other required members. They throw rather than no-op: if
 * the propose path ever reaches one of these, that is a finding, and a
 * silent no-op would hide it.
 */
const unused = (method: string) => async (): Promise<never> => {
	throw new Error(`this test never asks a provider to ${method}`);
};

/** What the tool asks a provider to open. */
type ProposeRequest = {
	repo: RepoLocator;
	base: string;
	head: string;
	title: string;
	body: string;
	draft: boolean;
};

/**
 * A provider that maps any checkout onto one hosted repo and records
 * every propose it is asked for.
 */
function recordingProvider() {
	const asked: ProposeRequest[] = [];
	const provider = stubProvider({
		id: "meteorite",
		priority: 50,
		claimRepo: () => world,
		capabilities: { authoring: CAN_ONLY_PROPOSE },
		facets: {
			authoring: {
				edit: unused("edit a change"),
				close: unused("close a change"),
				merge: unused("merge a change"),
				propose: async (request: ProposeRequest): Promise<Proposal> => {
					asked.push(request);
					return {
						ref: {
							provider: "meteorite",
							repo: request.repo,
							id: "1",
							label: "shop/world#1",
						},
						title: request.title,
						body: request.body,
						state: "open",
						draft: request.draft,
						author: { id: "joel.gerber" },
						base: request.base,
						head: request.head,
						url: "https://example.invalid/1",
					};
				},
			},
		},
	});
	return { provider, asked };
}

/** Drive the registered tool the way pi would, with no UI to draw on. */
async function offer(params: Record<string, unknown>) {
	const stub = activate();
	const tool = toolNamed(stub, "review_offer");
	const answer = await tool.execute(
		"1",
		params,
		undefined,
		undefined,
		HEADLESS,
	);
	return answer;
}

/** The same, for the reading tool. */
async function review(params: Record<string, unknown>) {
	const stub = activate();
	const tool = toolNamed(stub, "review");
	return await tool.execute("1", params, undefined, undefined, HEADLESS);
}

const proposal = {
	action: "propose",
	draft: true,
	base: "main",
	head: "topic",
	// Title Case, because a PR title here is not a commit subject: the
	// gate refuses a conventional-commit prefix on one.
	title: "Remember the Whole Resolution a Target Was Bound To",
	body: BODY,
};

afterEach(() => {
	clearReviewProviders();
	clearTargetBindings();
});

describe("asking what can be done here", () => {
	it("answers for a checkout with no change, base or head named", async () => {
		// This used to be refused with "Name a change, or a base and head, or
		// a list of refs", which answers a question nobody asked: what can be
		// done here is about the repo, and it is asked before there is a
		// change to ask it about.
		const { provider } = recordingProvider();
		registerReviewProvider(provider);

		const answer = await review({ action: "capabilities" });
		const text = JSON.stringify(answer);

		expect(text).toContain("meteorite");
		expect(text).toContain("serves");
		expect(text).not.toContain("Name a change");
	});
});

describe("proposing through the tool", () => {
	it("hands the provider the repo it claimed, not the local checkout", async () => {
		const { provider, asked } = recordingProvider();
		registerReviewProvider(provider);

		await offer(proposal);

		expect(asked).toHaveLength(1);
		expect(asked[0]?.repo.key).toBe(world.key);
	});

	it("still hands over the hosted repo on a call after the first", async () => {
		// The exact sequence from the session. The target resolves once and
		// is remembered; every later call replays what was remembered, and
		// what was remembered used to be rebuilt from the target, so it
		// arrived as `local:` and the provider refused it.
		const { provider, asked } = recordingProvider();
		registerReviewProvider(provider);

		await offer(proposal);
		await offer(proposal);

		expect(asked).toHaveLength(2);
		expect(asked[1]?.repo.key).toBe(world.key);
	});

	it("refuses a login where the backend names people by email", async () => {
		// Before anything is sent, because this backend refuses an assignee on
		// the request that creates the change: finding out afterwards means
		// finding out with the change already up. Nothing is translated, since
		// a login cannot become an email without asking somebody.
		const { provider, asked } = recordingProvider();
		registerReviewProvider(provider);

		const answer = await offer({ ...proposal, assignees: ["Jitsusama"] });

		expect(asked).toHaveLength(0);
		expect(JSON.stringify(answer)).toContain("Jitsusama");
		expect(JSON.stringify(answer)).toMatch(/email/i);
	});

	it("lets an email through to a backend that wants one", async () => {
		const { provider, asked } = recordingProvider();
		registerReviewProvider(provider);

		await offer({ ...proposal, assignees: ["joel.gerber@shopify.com"] });

		expect(asked).toHaveLength(1);
	});

	it("refuses on the provider's own terms when it cannot author", async () => {
		// Pins the decision not to compare the checkout against a `local:`
		// key. `repoElsewhere` stays silent on one, so this propose reaches
		// the capability check and is refused for the reason that is actually
		// true. A checkout-versus-repo complaint here would name one place
		// twice and say a branch cannot be proposed where it already is.
		registerReviewProvider(
			stubProvider({
				id: "plain-vcs",
				priority: 900,
				claimRepo: () => ({ key: "local:/src/app", localPath: "/src/app" }),
			}),
		);

		const answer = await offer(proposal);

		expect(JSON.stringify(answer)).toContain("does not author changes");
	});

	it("refuses on the words before it asks any provider anything", async () => {
		// A convention refusal should leave nothing behind. Binding remembers
		// what it resolved for the rest of the session, and a call that was
		// never going to be sent has no business recording a decision. It also
		// costs no backend round trip this way.
		let claims = 0;
		registerReviewProvider(
			stubProvider({
				id: "meteorite",
				priority: 50,
				claimRepo: () => {
					claims += 1;
					return world;
				},
			}),
		);

		await offer({ ...proposal, title: "fix(review): a commit subject" });

		expect(claims).toBe(0);
	});

	it("survives a refusal in between, which is when a retry happens", async () => {
		// Nobody proposes the same change twice for fun. The retry that
		// exposed this followed a convention gate refusing the title, so the
		// refusal has to leave the binding fit to use rather than poisoned.
		const { provider, asked } = recordingProvider();
		registerReviewProvider(provider);

		const refused = await offer({
			...proposal,
			title: "fix(review): remember the whole resolution",
		});
		expect(asked).toHaveLength(0);
		expect(JSON.stringify(refused)).toMatch(/title/i);

		await offer(proposal);

		expect(asked).toHaveLength(1);
		expect(asked[0]?.repo.key).toBe(world.key);
	});
});

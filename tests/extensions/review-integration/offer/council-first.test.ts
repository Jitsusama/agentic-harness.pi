/**
 * Every door that puts a change in front of people waits for our own
 * council: a proposal for review, a draft proposed with reviewers, a
 * stack proposed for review, a move to ready and a request for
 * reviewers. Driven through the tool, with councils judged by a stand-in
 * that records what it was asked about.
 */

import { afterEach, describe, expect, it } from "vitest";
import { witnessCouncilsWith } from "../../../../extensions/review-integration/reviewed-first.ts";
import {
	type AuthoringCapabilities,
	type Change,
	type ChangeRef,
	clearReviewProviders,
	clearTargetBindings,
	type RepoLocator,
	registerReviewProvider,
} from "../../../../lib/core/review/index.ts";
import { composePrBody } from "../../../../lib/core/sections/index.ts";
import { stubProvider } from "../../../support/stub-provider.ts";
import {
	activate,
	HEADLESS,
	toolNamed,
} from "../../support/review-extension.ts";

const world: RepoLocator = { key: "meteorite:shop/world" };

const BODY = composePrBody({
	tldr: "A change waits for our own council before anyone is asked.",
	problem: "People were asked first.",
	solution: "The tool asks the ledger first.",
	validation: "This test.",
});

const CAN_DO_IT_ALL: AuthoringCapabilities = {
	propose: true,
	proposeStack: true,
	reviewersAt: "any-time",
	retarget: "never",
	setDraft: true,
	close: false,
	reopen: false,
	merge: false,
	labels: false,
	assignees: false,
	identifies: "login",
	rerunChecks: false,
	refusesWhileEnqueued: false,
};

const unused = (method: string) => async (): Promise<never> => {
	throw new Error(`this test never asks a provider to ${method}`);
};

function changeAt(id: string, head: string, draft: boolean): Change {
	return {
		ref: { provider: "meteorite", repo: world, id, label: `shop/world#${id}` },
		title: "Wait for Our Own Council",
		body: BODY,
		state: "open",
		draft,
		author: { id: "joel" },
		base: "main",
		head,
		headCommit: "c".repeat(40),
		url: `https://example.invalid/${id}`,
	};
}

/** A backend that can do every gated thing, and records each it did. */
function recordingProvider(
	options: { fetches?: boolean; refuses?: string } = {},
) {
	const did: string[] = [];
	const provider = stubProvider({
		id: "meteorite",
		priority: 50,
		claimRepo: () => world,
		claimReference: (input): ChangeRef => ({
			provider: "meteorite",
			repo: world,
			id: input,
			label: `shop/world#${input}`,
		}),
		capabilities: { authoring: CAN_DO_IT_ALL },
		facets: {
			...(options.fetches === false
				? {}
				: {
						changes: {
							fetch: async (ref: ChangeRef) => changeAt(ref.id, "topic", true),
							diff: unused("diff a change"),
						},
					}),
			authoring: {
				edit: unused("edit a change"),
				close: unused("close a change"),
				merge: unused("merge a change"),
				propose: async (request: { head: string; draft: boolean }) => {
					did.push(`propose ${request.head}${request.draft ? " draft" : ""}`);
					return changeAt("1", request.head, request.draft);
				},
				proposeStack: async (requests: { head: string }[]) => {
					did.push(`stack ${requests.map((one) => one.head).join(",")}`);
					return requests.map((one, at) =>
						changeAt(String(at + 1), one.head, true),
					);
				},
				setDraft: async (_change: ChangeRef, draft: boolean) => {
					did.push(draft ? "draft" : "ready");
				},
				requestReviewers: async (_change: ChangeRef, people: string[]) => {
					did.push(`ask ${people.join(",")}`);
				},
				reviewersRefusal: () => options.refuses,
			},
		},
	});
	return { provider, did };
}

/**
 * What the stand-in judge was asked. It answers `read` when that is a
 * yes or no, and otherwise whether a council read one of the commits.
 */
function judging(read: boolean | ReadonlySet<string>) {
	const asked: { repo: string; commits: string[] }[] = [];
	witnessCouncilsWith(async (repo, commits) => {
		asked.push({ repo, commits: [...commits] });
		return typeof read === "boolean"
			? read
			: [...commits].some((sha) => read.has(sha));
	});
	return asked;
}

/** Each of a two-change stack's own commits, as the checkout lists them. */
const ONE = "1".repeat(40);
const TWO = "2".repeat(40);
const STACK_COMMITS = {
	"origin/main..origin/one": { stdout: `${ONE}\n` },
	"origin/one..origin/two": { stdout: `${TWO}\n` },
};

async function offer(
	params: Record<string, unknown>,
	read: boolean | ReadonlySet<string>,
) {
	const stub = activate({
		"log -1 --format=%s": { stdout: "A Tip Subject" },
		...STACK_COMMITS,
	});
	const asked = judging(read);
	const tool = toolNamed(stub, "review_offer");
	const answer = await tool.execute(
		"1",
		params,
		undefined,
		undefined,
		HEADLESS,
	);
	return { text: JSON.stringify(answer), asked };
}

const proposal = {
	action: "propose",
	base: "main",
	head: "topic",
	title: "Wait for Our Own Council",
	body: BODY,
};

afterEach(() => {
	clearReviewProviders();
	clearTargetBindings();
});

describe("waiting for our own council", () => {
	it("asks about the change's own repo", async () => {
		const { provider } = recordingProvider();
		registerReviewProvider(provider);

		const { asked } = await offer({ ...proposal, draft: false }, true);

		expect(asked.map((one) => one.repo)).toEqual([world.key]);
	});

	it("holds a draft proposed with reviewers, who would be asked to look", async () => {
		const { provider, did } = recordingProvider();
		registerReviewProvider(provider);

		const { text } = await offer(
			{ ...proposal, draft: true, reviewers: ["someone"] },
			false,
		);

		expect(did).toEqual([]);
		expect(text).toContain("No council of ours has read main..topic");
	});

	it("holds a stack proposed for review", async () => {
		const { provider, did } = recordingProvider();
		registerReviewProvider(provider);

		const { text } = await offer(
			{
				action: "propose-stack",
				draft: false,
				base: "main",
				heads: ["one", "two"],
			},
			false,
		);

		expect(did).toEqual([]);
		expect(text).toContain("No council of ours has read main..one");
	});

	it("holds a stack whose council read only its top change", async () => {
		const { provider, did } = recordingProvider();
		registerReviewProvider(provider);

		const { text, asked } = await offer(
			{
				action: "propose-stack",
				draft: false,
				base: "main",
				heads: ["one", "two"],
			},
			new Set([TWO]),
		);

		expect(did).toEqual([]);
		expect(asked.map((one) => one.commits)).toEqual([[ONE]]);
		expect(text).toContain("No council of ours has read main..one");
	});

	it("puts a stack up once each change's own commits were read", async () => {
		const { provider, did } = recordingProvider();
		registerReviewProvider(provider);

		const { asked } = await offer(
			{
				action: "propose-stack",
				draft: false,
				base: "main",
				heads: ["one", "two"],
			},
			new Set([ONE, TWO]),
		);

		expect(asked.map((one) => one.commits)).toEqual([[ONE], [TWO]]);
		expect(did).toEqual(["stack one,two"]);
	});

	it("lets a stack up as drafts", async () => {
		const { provider, did } = recordingProvider();
		registerReviewProvider(provider);

		await offer(
			{
				action: "propose-stack",
				draft: true,
				base: "main",
				heads: ["one", "two"],
			},
			false,
		);

		expect(did).toEqual(["stack one,two"]);
	});

	it("holds a move to ready, and asks about the head its backend names", async () => {
		const { provider, did } = recordingProvider();
		registerReviewProvider(provider);

		const { text, asked } = await offer(
			{ action: "ready", change: "7" },
			false,
		);

		expect(did).toEqual([]);
		expect(text).toContain("isn't marked ready");
		expect(asked[0]?.commits).toContain("c".repeat(40));
	});

	it("lets a move back to draft through, which asks nobody", async () => {
		const { provider, did } = recordingProvider();
		registerReviewProvider(provider);

		await offer({ action: "unready", change: "7" }, false);

		expect(did).toEqual(["draft"]);
	});

	it("holds a request for reviewers", async () => {
		const { provider, did } = recordingProvider();
		registerReviewProvider(provider);

		const { text } = await offer(
			{ action: "reviewers", change: "7", reviewers: ["someone"] },
			false,
		);

		expect(did).toEqual([]);
		expect(text).toContain("isn't put to reviewers");
	});

	it("asks them once a council has read it", async () => {
		const { provider, did } = recordingProvider();
		registerReviewProvider(provider);

		await offer(
			{ action: "reviewers", change: "7", reviewers: ["someone"] },
			true,
		);

		expect(did).toEqual(["ask someone"]);
	});

	it("refuses reviewers no ask could take before the council or the gate", async () => {
		const { provider, did } = recordingProvider({
			refuses: "elsewhere/ci is a team of elsewhere. Nobody was asked.",
		});
		registerReviewProvider(provider);

		const { text, asked } = await offer(
			{ action: "reviewers", change: "7", reviewers: ["elsewhere/ci"] },
			true,
		);

		expect(did, "nobody is asked").toEqual([]);
		expect(asked, "no council is consulted for it").toEqual([]);
		expect(text, "the refusal is said").toContain(
			"is a team of elsewhere. Nobody was asked.",
		);
	});

	it("holds it when the backend can't say what the change's commits are", async () => {
		const { provider, did } = recordingProvider({ fetches: false });
		registerReviewProvider(provider);

		const { text, asked } = await offer({ action: "ready", change: "7" }, true);

		expect(did).toEqual([]);
		expect(asked).toEqual([]);
		expect(text).toContain("can't say what its commits are");
	});
});

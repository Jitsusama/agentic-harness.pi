/**
 * V14 and V15 of the validation plan: the sequences a person produces and a
 * test usually does not.
 *
 * V14 is two branches in one session and then back to the first. Bindings are
 * remembered per target, so one target's answer standing in for another's is
 * the failure this shape looks for, and the original defect was exactly a
 * remembered resolution rebuilding the wrong half of its answer. A test that
 * proposes once cannot see it.
 *
 * V15 is an edit that touches several fields at once. The gate has to show
 * the body whole rather than a slice of it, and a field nobody mentioned has
 * to read as untouched rather than as cleared, since the difference between
 * those two is a label somebody loses.
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
import { editPanel } from "../../extensions/review-integration/tools/offer.js";
import { stubProvider } from "../support/stub-provider.js";
import { activate, HEADLESS, toolNamed } from "./support/review-extension.js";

const world: RepoLocator = { key: "meteorite:shop/world" };

const BODY = [
	"### 🌐 Situation",
	"",
	"Two branches in one session, and then the first one again.",
	"",
	"### 🔧 Resolution",
	"",
	"Each target keeps its own answer.",
	"",
	"### 🔬 Validation",
	"",
	"This test.",
].join("\n");

const CAN_PROPOSE: AuthoringCapabilities = {
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

const unused = (method: string) => async (): Promise<never> => {
	throw new Error(`this test never asks a provider to ${method}`);
};

type ProposeRequest = {
	repo: RepoLocator;
	base: string;
	head: string;
	title: string;
	body: string;
	draft: boolean;
};

/** A backend that records the repo and head of every propose it is handed. */
function recordingProvider() {
	const asked: ProposeRequest[] = [];
	const provider = stubProvider({
		id: "meteorite",
		priority: 50,
		claimRepo: () => world,
		capabilities: { authoring: CAN_PROPOSE },
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
							id: request.head,
							label: `shop/world#${request.head}`,
						},
						title: request.title,
						body: request.body,
						state: "open",
						draft: request.draft,
						author: { id: "joel.gerber" },
						base: request.base,
						head: request.head,
						url: `https://example.invalid/${request.head}`,
					};
				},
			},
		},
	});
	return { provider, asked };
}

async function propose(head: string) {
	const stub = activate();
	const tool = toolNamed(stub, "review_offer");
	return await tool.execute(
		"1",
		{
			action: "propose",
			draft: true,
			base: "main",
			head,
			title: "Keep Each Target's Own Answer",
			body: BODY,
		},
		undefined,
		undefined,
		HEADLESS,
	);
}

afterEach(() => {
	clearReviewProviders();
	clearTargetBindings();
});

describe("several targets in one session", () => {
	it("hands over the hosted repo for each, and for the first one again", async () => {
		const { provider, asked } = recordingProvider();
		registerReviewProvider(provider);

		await propose("first");
		await propose("second");
		await propose("first");

		expect(asked.map((one) => one.head)).toEqual(["first", "second", "first"]);
		// Every one of them, not just the first: a remembered resolution that
		// rebuilds half its answer reports the checkout's own key instead.
		expect(asked.map((one) => one.repo.key)).toEqual([
			world.key,
			world.key,
			world.key,
		]);
	});

	it("does not let one target's branch stand in for another's", async () => {
		const { provider, asked } = recordingProvider();
		registerReviewProvider(provider);

		await propose("first");
		await propose("second");

		expect(asked[1]?.head).toBe("second");
	});
});

describe("an edit that touches several fields", () => {
	it("shows the body whole rather than a slice of it", () => {
		const panel = editPanel({
			label: "shop/world#438",
			edits: {
				title: { action: "set", value: "A New Title" },
				body: { action: "set", value: BODY },
				labels: { action: "add", value: ["risky"] },
			},
		});

		// The whole body, to the last line. An edit gate that shows the first
		// two hundred characters is asking for approval of something unread.
		expect(panel.payload?.body).toBe(BODY);
		expect(panel.payload?.body).toContain("This test.");
	});

	it("names the body once, not twice", () => {
		const panel = editPanel({
			label: "shop/world#438",
			edits: { body: { action: "set", value: BODY } },
		});

		expect(panel.consequence ?? []).not.toContain("body: ");
	});

	it("says which way a set edit is going", () => {
		// "labels: risky" reads as a replacement and usually is not one.
		const panel = editPanel({
			label: "shop/world#438",
			edits: { labels: { action: "add", value: ["risky"] } },
		});

		expect((panel.consequence ?? []).join("\n")).toContain("add risky");
	});

	it("reads an untouched field as unchanged, never as cleared", () => {
		const panel = editPanel({
			label: "shop/world#438",
			edits: {
				title: { action: "set", value: "A New Title" },
				labels: undefined,
			},
		});
		const said = (panel.consequence ?? []).join("\n");

		expect(said).toContain("labels: unchanged");
		expect(said).not.toContain("labels: cleared");
	});
});

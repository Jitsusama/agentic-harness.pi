/**
 * A description given as its four sections rather than as one string.
 *
 * The tool writes the headings and the order from the fields, so a
 * proposal cannot arrive with the wrong skeleton whatever the guard
 * policy says, and an edit can replace one section and keep the rest.
 */

import { afterEach, describe, expect, it } from "vitest";
import { forgetRefusals } from "../../extensions/review-integration/tools/resubmit.ts";
import {
	type AuthoringCapabilities,
	type Change,
	clearReviewProviders,
	clearTargetBindings,
	type RepoLocator,
	registerReviewProvider,
} from "../../lib/core/review/index.ts";
import {
	composePrBody,
	PR_SECTIONS,
	readPrFields,
} from "../../lib/core/sections/index.ts";
import { stubProvider } from "../support/stub-provider.ts";
import { activate, HEADLESS, toolNamed } from "./support/review-extension.ts";

const world: RepoLocator = { key: "meteorite:shop/world" };

const CAN_AUTHOR: AuthoringCapabilities = {
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

const SECTIONS = {
	problem: "Merging failed 23 times in two months on a short commit id.",
	solution:
		"Merge expands a short id to the full one before it asks, because GitHub wants the full one.",
	validation: "A test sends a short id and checks the full one arrives.",
	tldr: "Merging with a short commit id now works the first time.",
};

/** A provider that records what it is asked to open and to edit. */
function recordingProvider(current: string = composePrBody(SECTIONS)) {
	const proposed: { body: string; title?: string }[] = [];
	const edited: (string | undefined)[] = [];
	const existing: Change = {
		ref: { provider: "meteorite", repo: world, id: "7", label: "shop/world#7" },
		title: "Merge Short Commit Ids",
		body: current,
		state: "open",
		draft: false,
		author: { id: "joel.gerber" },
		base: "main",
		head: "topic",
		url: "https://example.invalid/7",
	};
	const provider = stubProvider({
		id: "meteorite",
		priority: 50,
		claimRepo: () => world,
		claimReference: (input) => ({
			provider: "meteorite",
			repo: world,
			id: input,
			label: `shop/world#${input}`,
		}),
		capabilities: { authoring: CAN_AUTHOR },
		facets: {
			changes: {
				fetch: async () => existing,
				diff: unused("diff a change"),
			},
			authoring: {
				close: unused("close a change"),
				merge: unused("merge a change"),
				propose: async (request: { body: string; title?: string }) => {
					proposed.push(request);
					return { ...existing, body: request.body };
				},
				edit: async (_ref, edit) => {
					edited.push(
						edit.body?.action === "set" ? edit.body.value : undefined,
					);
					return existing;
				},
			},
		},
	});
	return { provider, proposed, edited };
}

async function offer(params: Record<string, unknown>) {
	const stub = activate();
	const tool = toolNamed(stub, "review_offer");
	return await tool.execute("1", params, undefined, undefined, HEADLESS);
}

const proposing = {
	action: "propose",
	draft: true,
	base: "main",
	head: "topic",
	title: "Merge Short Commit Ids",
};

afterEach(() => {
	clearReviewProviders();
	clearTargetBindings();
	forgetRefusals();
});

describe("proposing with sections", () => {
	it("writes the headings and order from the four fields", async () => {
		const { provider, proposed } = recordingProvider();
		registerReviewProvider(provider);

		await offer({ ...proposing, ...SECTIONS });

		const body = proposed[0]?.body ?? "";
		expect(body.startsWith(PR_SECTIONS[0])).toBe(true);
		expect(readPrFields(body).fields).toEqual(SECTIONS);
	});

	it("refuses a proposal missing a section, naming it", async () => {
		const { provider, proposed } = recordingProvider();
		registerReviewProvider(provider);

		const { validation: _, ...three } = SECTIONS;
		const answer = JSON.stringify(await offer({ ...proposing, ...three }));

		expect(answer).toContain("missing validation");
		expect(proposed).toHaveLength(0);
	});

	it("refuses sections and a body together", async () => {
		const { provider, proposed } = recordingProvider();
		registerReviewProvider(provider);

		const answer = JSON.stringify(
			await offer({ ...proposing, ...SECTIONS, body: composePrBody(SECTIONS) }),
		);

		expect(answer).toContain("not both");
		expect(proposed).toHaveLength(0);
	});

	it("refuses a TL;DR that is not an eight-second read, whatever the guards say", async () => {
		const { provider, proposed } = recordingProvider();
		registerReviewProvider(provider);

		const tldr = `${Array.from({ length: 50 }, () => "word").join(" ")}.`;
		const answer = JSON.stringify(
			await offer({ ...proposing, ...SECTIONS, tldr }),
		);

		expect(answer).toContain("TL;DR is 50 words");
		expect(proposed).toHaveLength(0);
	});

	it("says so when a refused description comes back unchanged", async () => {
		const { provider, proposed } = recordingProvider();
		registerReviewProvider(provider);
		const tldr = `${Array.from({ length: 45 }, () => "words").join(" ")}.`;

		const first = JSON.stringify(
			await offer({ ...proposing, ...SECTIONS, tldr }),
		);
		const again = JSON.stringify(
			await offer({ ...proposing, ...SECTIONS, tldr }),
		);
		const changed = JSON.stringify(
			await offer({ ...proposing, ...SECTIONS, tldr: `${tldr} More.` }),
		);

		expect(first).not.toContain("word for word");
		expect(again).toContain("word for word the description refused");
		expect(again).toContain("TL;DR is 45 words");
		expect(changed).not.toContain("word for word");
		expect(proposed).toHaveLength(0);
	});

	it("takes a resubmit of only what changed, keeping the rest of the refused draft", async () => {
		// 487 refusals in 44 sessions, each followed by the whole
		// description written out again to change one section.
		const { provider, proposed } = recordingProvider();
		registerReviewProvider(provider);
		const long = `${Array.from({ length: 45 }, () => "words").join(" ")}.`;

		const refused = JSON.stringify(
			await offer({ ...proposing, ...SECTIONS, tldr: long }),
		);
		const { title: _, ...untitled } = proposing;
		await offer({ ...untitled, tldr: SECTIONS.tldr });

		expect(refused).toContain("give only the title or sections you change");
		expect(proposed).toHaveLength(1);
		expect(readPrFields(proposed[0]?.body ?? "").fields).toEqual(SECTIONS);
	});

	it("puts a title written as a sentence in Title Case rather than refusing it", async () => {
		const { provider, proposed } = recordingProvider();
		registerReviewProvider(provider);

		await offer({
			...proposing,
			...SECTIONS,
			title: "merge short commit ids the first time",
		});

		expect(proposed).toHaveLength(1);
		expect(proposed[0]).toMatchObject({
			title: "Merge Short Commit Ids the First Time",
		});
	});

	it("keeps nothing from another branch's refused draft", async () => {
		const { provider, proposed } = recordingProvider();
		registerReviewProvider(provider);
		const long = `${Array.from({ length: 45 }, () => "words").join(" ")}.`;

		await offer({ ...proposing, ...SECTIONS, tldr: long });
		const answer = JSON.stringify(
			await offer({ ...proposing, head: "other", tldr: SECTIONS.tldr }),
		);

		expect(answer).toContain("missing problem, solution, validation");
		expect(proposed).toHaveLength(0);
	});
});

describe("editing some sections", () => {
	it("replaces the sections named and keeps the rest", async () => {
		const { provider, edited } = recordingProvider();
		registerReviewProvider(provider);

		await offer({
			action: "edit",
			change: "7",
			solution: "Merge now asks for the full id itself, so a short one works.",
		});

		expect(readPrFields(edited[0] ?? "").fields).toEqual({
			...SECTIONS,
			solution: "Merge now asks for the full id itself, so a short one works.",
		});
	});

	it("refuses to patch a description in the retired shape", async () => {
		const old = "### Situation\n\nOld.\n\n### Resolution\n\nOld.";
		const { provider, edited } = recordingProvider(old);
		registerReviewProvider(provider);

		const answer = JSON.stringify(
			await offer({ action: "edit", change: "7", tldr: SECTIONS.tldr }),
		);

		expect(answer).toContain("Give all four sections");
		expect(edited).toHaveLength(0);
	});

	it("replaces a retired description when given all four", async () => {
		const old = "### Situation\n\nOld.\n\n### Resolution\n\nOld.";
		const { provider, edited } = recordingProvider(old);
		registerReviewProvider(provider);

		await offer({ action: "edit", change: "7", ...SECTIONS });

		expect(readPrFields(edited[0] ?? "").fields).toEqual(SECTIONS);
	});
});

/**
 * The queue gate, composed the way the tool composes it.
 *
 * Every part of this path had tests and the path itself did not work.
 * `offerable` refused an enqueued mutation, `AuthoringIntent` carried an
 * `enqueued` flag, and no caller anywhere set it, so the refusal could
 * not be reached. The GitHub provider then declared
 * `refusesWhileEnqueued: false`, which would have made it dead a second
 * time even once a caller did.
 *
 * So this suite deliberately spans the seam: a real provider reading a
 * real GraphQL answer shape, handed to the real gate. A unit test on
 * either side passes while the whole thing does nothing.
 */

import { describe, expect, it } from "vitest";
import {
	type AuthoringCapabilities,
	createGitHubProvider,
	offerable,
} from "../../../lib/review/index.js";
import { fakeExec } from "./support/fake-exec.js";

const REPO = { key: "github:Shopify/world" };
const CHANGE = {
	provider: "github",
	repo: REPO,
	id: "42",
	label: "Shopify/world#42",
};

/** The REST body `fetch` reads, trimmed to what it looks at. */
const REST = JSON.stringify({
	number: 42,
	title: "A change",
	body: "",
	state: "open",
	draft: false,
	user: { login: "someone" },
	base: { ref: "main" },
	head: { ref: "topic", sha: "abc123" },
});

/** A GraphQL answer, in the envelope `gh api graphql` really returns. */
function graphql(pullRequest: unknown): string {
	return JSON.stringify({ data: { repository: { pullRequest } } });
}

/** Read the proposal back through the provider, with a scripted CLI. */
async function proposalWith(pullRequest: unknown) {
	const { exec } = fakeExec([
		{ when: ["api", "repos/Shopify/world/pulls/42"], stdout: REST },
		{ when: ["api", "graphql"], stdout: graphql(pullRequest) },
	]);
	const provider = createGitHubProvider({ exec });
	const proposal = await provider.proposals?.fetch(CHANGE);
	if (!proposal) throw new Error("the provider read no proposal");
	return proposal;
}

/** What GitHub declares about itself, for the gate to consult. */
async function githubAuthoringCapabilities(): Promise<AuthoringCapabilities> {
	const { exec } = fakeExec([]);
	const capabilities = await createGitHubProvider({ exec }).capabilities(REPO);
	if (!capabilities.authoring) {
		throw new Error("the GitHub provider declares no authoring capabilities");
	}
	return capabilities.authoring;
}

describe("reading a merge queue through the provider", () => {
	it("reports unqueued for a change nobody has asked to merge", async () => {
		const proposal = await proposalWith({
			autoMergeRequest: null,
			mergeQueueEntry: null,
		});

		expect(proposal.queue?.posture).toBe("unqueued");
	});

	it("carries the queue onto the proposal, where the gate can find it", async () => {
		const proposal = await proposalWith({
			mergeQueueEntry: { state: "QUEUED", position: 7, solo: false },
		});

		expect(proposal.queue).toEqual({
			posture: "queued",
			position: 7,
			solo: false,
			detail: "merge queue entry is QUEUED",
		});
	});

	it("still reads the change when the queue query fails", async () => {
		// An older GitHub, or a token without the scope. The change itself
		// must survive, since reading must not depend on authoring.
		const { exec } = fakeExec([
			{ when: ["api", "repos/Shopify/world/pulls/42"], stdout: REST },
		]);
		const proposal = await createGitHubProvider({ exec }).proposals?.fetch(
			CHANGE,
		);

		expect(proposal?.title).toBe("A change");
		expect(proposal?.queue).toBeUndefined();
	});
});

describe("the gate, given what the provider read", () => {
	it("refuses to retarget a change that is holding a place in the queue", async () => {
		const proposal = await proposalWith({
			mergeQueueEntry: { state: "QUEUED", position: 7, solo: false },
		});

		const answer = offerable(
			{ kind: "retarget", queue: proposal.queue },
			await githubAuthoringCapabilities(),
			"github",
		);

		expect(answer.ok).toBe(false);
		expect(!answer.ok && answer.reason).toContain("batched with it");
		expect(!answer.ok && answer.reason).toContain("7th");
	});

	it("permits the same retarget when the queue is empty", async () => {
		const proposal = await proposalWith({
			autoMergeRequest: null,
			mergeQueueEntry: null,
		});

		expect(
			offerable(
				{ kind: "retarget", queue: proposal.queue },
				await githubAuthoringCapabilities(),
				"github",
			).ok,
		).toBe(true);
	});

	it("permits it when the queue could not be read at all", async () => {
		// Unknown must not become refused, or an old GitHub becomes a
		// read-only one.
		expect(
			offerable(
				{ kind: "retarget", queue: undefined },
				await githubAuthoringCapabilities(),
				"github",
			).ok,
		).toBe(true);
	});

	it("declares that it cares about the queue at all", async () => {
		// The regression that made this dead twice over. A provider that
		// says false here is never asked, whatever it reports.
		expect((await githubAuthoringCapabilities()).refusesWhileEnqueued).toBe(
			true,
		);
	});
});

/**
 * Projecting a neutral proposal onto the metadata this workflow
 * speaks.
 *
 * The two shapes disagree in small ways that each hide a decision:
 * the workflow wants GitHub's uppercase states, insists on a url
 * and a timestamp the substrate leaves optional, and displays a
 * size the provider may not have reported.
 */

import { describe, expect, it } from "vitest";
import { metadataFromProposal } from "../../../extensions/pr-workflow/fetch.js";
import type { Proposal } from "../../../lib/review/index.js";

function proposal(overrides: Partial<Proposal> = {}): Proposal {
	return {
		ref: {
			provider: "github",
			repo: { key: "github:o/r" },
			id: "7",
			label: "o/r#7",
		},
		title: "Teach the widget to fly",
		body: "It cannot fly.",
		state: "open",
		draft: false,
		author: { id: "octocat" },
		base: "main",
		head: "widget-flight",
		headCommit: "abc1234",
		url: "https://github.com/o/r/pull/7",
		createdAt: "2026-07-01T00:00:00Z",
		updatedAt: "2026-07-02T00:00:00Z",
		additions: 12,
		deletions: 3,
		changedFiles: 4,
		...overrides,
	};
}

describe("metadataFromProposal", () => {
	it("carries the change across, state shouted the way the view expects", () => {
		const meta = metadataFromProposal(proposal());

		expect(meta).toEqual({
			title: "Teach the widget to fly",
			author: "octocat",
			state: "OPEN",
			isDraft: false,
			url: "https://github.com/o/r/pull/7",
			body: "It cannot fly.",
			base: { ref: "main", sha: "" },
			head: { ref: "widget-flight", sha: "abc1234" },
			additions: 12,
			deletions: 3,
			changedFiles: 4,
			createdAt: "2026-07-01T00:00:00Z",
			updatedAt: "2026-07-02T00:00:00Z",
		});
	});

	it("shouts each state the substrate whispers", () => {
		const states = (["open", "merged", "closed"] as const).map(
			(state) => metadataFromProposal(proposal({ state })).state,
		);

		expect(states).toEqual(["OPEN", "MERGED", "CLOSED"]);
	});

	it("reports an unmeasured change as zero rather than refusing it", () => {
		// The view has no way to render an absent count, and a
		// proposal without one is still a proposal worth showing.
		const meta = metadataFromProposal(
			proposal({
				additions: undefined,
				deletions: undefined,
				changedFiles: undefined,
			}),
		);

		expect(meta.additions).toBe(0);
		expect(meta.changedFiles).toBe(0);
	});

	it("tolerates a provider that reports no link or timestamps", () => {
		// All three are optional upstream and required here, and a
		// missing one must not become the word undefined on screen.
		const meta = metadataFromProposal(
			proposal({ url: undefined, createdAt: undefined, updatedAt: undefined }),
		);

		expect(meta.url).toBe("");
		expect(meta.createdAt).toBe("");
		expect(meta.updatedAt).toBe("");
	});

	it("leaves the head commit empty when the provider withholds it", () => {
		const meta = metadataFromProposal(proposal({ headCommit: undefined }));

		expect(meta.head).toEqual({ ref: "widget-flight", sha: "" });
	});
});

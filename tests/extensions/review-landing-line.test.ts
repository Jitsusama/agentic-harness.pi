/**
 * Saying whether a change could land.
 *
 * The narration is tested against the contract in `tests/lib/review/landing.test.ts`.
 * This is the other half of the seam: that the line a reader actually sees carries it.
 * A test on either side of a seam passes against a system that does not work, and this
 * substrate has shipped that exact defect three times, so the reader gets its own test.
 */

import { describe, expect, it } from "vitest";
import { proposalLine } from "../../extensions/review-integration/render.js";
import type { Landability, Proposal } from "../../lib/review/index.js";

function change(landing?: Landability): Proposal {
	return {
		ref: {
			label: "owner/repo#1",
			id: "1",
			provider: "github",
			repo: { key: "github:owner/repo" },
		},
		title: "Do the thing",
		body: "",
		state: "open",
		draft: false,
		author: { id: "someone" },
		head: "topic",
		base: "main",
		...(landing === undefined ? {} : { landing }),
	};
}

describe("labels and assignees on the change line", () => {
	it("shows them, since both providers parse them on every read", () => {
		// They were fetched by both providers and drawn by nothing, so editing
		// a label said a field had changed and then showed a change carrying
		// none.
		const line = proposalLine({
			...change(),
			labels: ["needs-review", "zone:web"],
			assignees: [{ id: "someone", name: "Some One" }],
		});

		expect(line).toContain("needs-review, zone:web");
		expect(line).toContain("assigned to Some One");
	});

	it("says nothing when a change carries none", () => {
		expect(proposalLine({ ...change(), labels: [], assignees: [] })).toBe(
			proposalLine(change()),
		);
	});
});

describe("the change line", () => {
	it("says what is stopping a change landing", () => {
		const line = proposalLine(
			change({ changesRequested: true, failingRequiredCheck: true }),
		);

		expect(line).toContain("changes were requested");
		expect(line).toContain("a required check is failing");
	});

	it("puts landing on its own line, not buried behind the size", () => {
		const line = proposalLine(change({ conflicted: true }));

		expect(line.split("\n").at(-1)).toContain("conflicts with its base");
	});

	it("says nothing at all when the backend did not say", () => {
		// Unreported is not clear to land. A change nobody has judged must not
		// read as ready in the line somebody skims before merging.
		const line = proposalLine(change());

		expect(line).not.toContain("land");
		expect(line.split("\n")).toHaveLength(2);
	});
});

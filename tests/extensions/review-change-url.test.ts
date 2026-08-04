/**
 * Saying where a change is.
 *
 * `url` sat on the contract with a provider filling it in and nothing
 * drawing it, so a propose answered with a label and a number and left
 * the one thing somebody wants next, the link to open, unsaid. On a
 * backend whose web address nobody can guess from a label, that means
 * going and looking for a change you just made.
 */

import { describe, expect, it } from "vitest";
import { proposalLine } from "../../extensions/review-integration/render.js";
import type { Proposal } from "../../lib/review/index.js";

function change(extra: Partial<Proposal>): Proposal {
	return {
		ref: {
			label: "shop/world#2001696",
			id: "2001696",
			provider: "meteorite",
			repo: { key: "meteorite:shop/world" },
		},
		title: "Something",
		state: "open",
		author: { id: "someone" },
		head: "topic",
		base: "main",
		draft: false,
		...extra,
	} as Proposal;
}

describe("saying where a change is", () => {
	it("prints the url the provider reported", () => {
		const line = proposalLine(
			change({ url: "https://gitstream.shopify.io/shop/world/pulls/2001696" }),
		);

		expect(line).toContain(
			"https://gitstream.shopify.io/shop/world/pulls/2001696",
		);
	});

	it("says nothing when the provider reported none", () => {
		// Absent means the backend does not publish one, which is not the
		// same as an empty link worth printing.
		const line = proposalLine(change({}));

		expect(line).not.toContain("http");
	});

	it("puts it on its own line, so it can be clicked or copied whole", () => {
		const line = proposalLine(change({ url: "https://example.invalid/1" }));
		const own = line
			.split("\n")
			.find((row) => row.includes("https://example.invalid/1"));

		expect(own?.trim()).toBe("https://example.invalid/1");
	});
});

/**
 * Proposing to a repo you are not in.
 *
 * The repo a proposal goes to comes from the attached change, because nothing
 * resolves the repo you are standing in to the system hosting it: `fromLocal`
 * mints a `local:` key, which the plain git provider claims and which has no
 * authoring facet. The branch, meanwhile, comes from the checkout. So the two
 * can disagree, and the result is a proposal offering a branch to a repo that
 * does not have it.
 *
 * Found by driving: with a Meteorite change attached and a public checkout in
 * front of me, `propose` would have offered the local branch to shop/world,
 * and the gate named a head and a base and never a repo.
 */

import { describe, expect, it } from "vitest";
import { proposingElsewhere } from "../../extensions/review-integration/tools/offer.js";

/** A pi whose `exec` answers one origin URL, or fails. */
function inCheckout(origin: string | undefined) {
	return {
		exec: async () =>
			origin === undefined
				? { code: 1, stdout: "", stderr: "no such remote" }
				: { code: 0, stdout: `${origin}\n`, stderr: "" },
	} as unknown as Parameters<typeof proposingElsewhere>[0];
}

describe("refusing a proposal aimed at another repo", () => {
	it("refuses when the checkout and the change in play disagree", async () => {
		const refusal = await proposingElsewhere(
			inCheckout("https://github.com/Jitsusama/agentic-harness.pi.git"),
			"/anywhere",
			{ repo: { key: "meteorite:shop/world" } },
		);

		expect(refusal).toContain("meteorite:shop/world");
		expect(refusal).toContain("Jitsusama/agentic-harness.pi");
	});

	it("says how to get out of it, both ways", async () => {
		// A refusal that names the collision without naming a door leaves a
		// caller stuck, since the attachment is the reason and is not
		// obviously connected to a proposal failing.
		const refusal = await proposingElsewhere(
			inCheckout("git@github.com:Jitsusama/agentic-harness.pi.git"),
			"/anywhere",
			{ repo: { key: "meteorite:shop/world" } },
		);

		expect(refusal).toMatch(/detach/i);
		expect(refusal).toMatch(/repo/);
	});

	it("permits the ordinary case, where they are the same repo", async () => {
		const refusal = await proposingElsewhere(
			inCheckout("https://github.com/Jitsusama/agentic-harness.pi.git"),
			"/anywhere",
			{ repo: { key: "github:Jitsusama/agentic-harness.pi" } },
		);

		expect(refusal).toBeUndefined();
	});

	it("treats ssh and https spellings of the same repo as the same", async () => {
		// Anything more exact would need a URL parser per backend, and this
		// only has to catch a disagreement rather than adjudicate a match.
		const refusal = await proposingElsewhere(
			inCheckout("git@github.com:Jitsusama/agentic-harness.pi.git"),
			"/anywhere",
			{ repo: { key: "github:Jitsusama/agentic-harness.pi" } },
		);

		expect(refusal).toBeUndefined();
	});

	it("says nothing when there is no remote to compare against", async () => {
		// A clone with no origin is a legitimate place to propose from: the
		// work may be going up to a repo it has never spoken to.
		const refusal = await proposingElsewhere(
			inCheckout(undefined),
			"/anywhere",
			{
				repo: { key: "github:Jitsusama/agentic-harness.pi" },
			},
		);

		expect(refusal).toBeUndefined();
	});

	it("says nothing about an unhosted target", async () => {
		// A `local:` key is a range or a stack in a checkout, which is not
		// something anybody proposes to.
		const refusal = await proposingElsewhere(
			inCheckout("https://github.com/other/repo.git"),
			"/anywhere",
			{ repo: { key: "local:/tmp/repo", localPath: "/tmp/repo" } },
		);

		expect(refusal).toBeUndefined();
	});
});

/**
 * Listing needs a repo, and nothing else.
 *
 * Every other action on this surface is about a change, so the shared
 * resolution insists on one: a reference, a range, a stack, or the
 * attachment standing in for all three. Listing is the exception, and
 * it went through that resolution anyway, so naming the one thing the
 * action is about was refused with "Name a change".
 *
 * The refusal is worse than it reads, because the way out is to attach
 * a change in the repo you wanted to list, which means already knowing
 * one of the answers you asked for. Met while looking for an open
 * change in a repo with nothing attached, which is exactly the state a
 * session is in when it starts.
 */

import { describe, expect, it } from "vitest";
import { activate, HEADLESS, toolNamed } from "./support/review-extension.js";

/** A checkout that says it is a GitHub repo, and one open change in it. */
const CHECKOUT = {
	"rev-parse --show-toplevel": { stdout: "/repo\n" },
	// Two spellings, because two readers ask differently: the engine's
	// probe reads every remote out of the config, and the guard against
	// listing a repo you did not name asks origin for its URL.
	"--get-regexp": {
		stdout: "remote.origin.url https://github.com/Shopify/world.git\n",
	},
	"remote get-url origin": {
		stdout: "https://github.com/Shopify/world.git\n",
	},
	"pr list": {
		stdout: JSON.stringify([
			{
				number: 41,
				title: "Teach the widget to fly",
				state: "OPEN",
				isDraft: false,
				author: { login: "someone" },
				headRefName: "widget-flight",
				baseRefName: "main",
				url: "https://github.com/Shopify/world/pull/41",
				updatedAt: "2026-08-10T00:00:00Z",
			},
		]),
	},
};

/** A change on a different repo from the checkout being named. */
const ELSEWHERE = {
	"Shopify/other/pulls/7": {
		stdout: JSON.stringify({
			number: 7,
			title: "Something else entirely",
			body: "",
			state: "open",
			draft: false,
			merged_at: null,
			user: { login: "someone" },
			base: { ref: "main" },
			head: { ref: "topic", sha: "abc1234" },
			html_url: "https://github.com/Shopify/other/pull/7",
			created_at: "2026-08-01T00:00:00Z",
			updated_at: "2026-08-02T00:00:00Z",
		}),
	},
};

describe("listing the changes in a repo", () => {
	it("answers for the repo it was given, with nothing attached", async () => {
		const stub = activate(CHECKOUT);
		const see = toolNamed(stub, "review_see");

		const answer = await see.execute(
			"call-1",
			{ action: "changes", repo: "/repo", state: "open" },
			undefined,
			undefined,
			HEADLESS,
		);

		expect(JSON.stringify(answer)).toContain("41");
	});

	it("still refuses a repo that contradicts the change in play", async () => {
		// The guard this sits beside only makes sense when a change was
		// resolved: being answered about another repo is possible exactly
		// when something other than the checkout decided which repo it
		// was. Now that a bare repo resolves to itself, the condition
		// carries that, and this is what would break if it stopped.
		const see = toolNamed(
			activate({ ...CHECKOUT, ...ELSEWHERE }),
			"review_see",
		);

		const answer = await see.execute(
			"call-2",
			{
				action: "changes",
				repo: "/repo",
				state: "open",
				change: "Shopify/other#7",
			},
			undefined,
			undefined,
			HEADLESS,
		);

		expect(JSON.stringify(answer)).toContain("would list");
	});
});

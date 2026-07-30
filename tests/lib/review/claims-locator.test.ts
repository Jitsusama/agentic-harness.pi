/**
 * A reference to the repo you are standing in should know where it is.
 *
 * Written-out references carried an owner and a name and nothing else, so
 * a change named in full described its repo as a key alone even when the
 * caller sat inside a checkout of that very repo. The consequence was
 * quiet and only visible from a long way off: a council asking for a
 * snapshot pinned to the commit under review was refused, because
 * `treeRequestFrom` will not cut a tree for a repo with "neither a local
 * checkout nor a remote", and the round fell back to letting reviewers
 * read whatever mutable directory the session happened to be in.
 *
 * No form escaped it, which the test below established against a guess to
 * the contrary. A bare number looked like it should have been safe, since
 * it can only be understood through the probed repo in the first place,
 * and it read the owner and name off that probe and then rebuilt the
 * locator from those two fields alone, discarding the rest. So a GitHub
 * change could never be reviewed against a pinned tree, however it was
 * written, which matches what driving a council actually showed.
 */

import { describe, expect, it } from "vitest";
import { claimGitHubReference } from "../../../lib/review/providers/github/claims.js";

/** The checkout a caller is standing in, as the engine's probe reports it. */
const STANDING_IN = {
	key: "github:Jitsusama/agentic-harness.pi",
	remoteUrl: "https://github.com/Jitsusama/agentic-harness.pi.git",
	localPath: "/Users/someone/src/github.com/Jitsusama/agentic-harness.pi",
};

/** A checkout of something else entirely. */
const SOMEWHERE_ELSE = {
	key: "github:Shopify/world",
	remoteUrl: "https://github.com/Shopify/world.git",
	localPath: "/Users/someone/world",
};

const FORMS = [
	["a short form", "Jitsusama/agentic-harness.pi#424"],
	[
		"a pull request URL",
		"https://github.com/Jitsusama/agentic-harness.pi/pull/424",
	],
] as const;

describe("an explicit reference to the repo around you", () => {
	for (const [what, input] of FORMS) {
		it(`learns the checkout from ${what}`, () => {
			const claimed = claimGitHubReference(input, STANDING_IN);

			expect(claimed?.repo.localPath).toBe(STANDING_IN.localPath);
			expect(claimed?.repo.remoteUrl).toBe(STANDING_IN.remoteUrl);
		});

		it(`still reads as the same change from ${what}`, () => {
			// Enriching the repo must not disturb which change was named.
			const claimed = claimGitHubReference(input, STANDING_IN);

			expect(claimed?.id).toBe("424");
			expect(claimed?.label).toBe("Jitsusama/agentic-harness.pi#424");
		});
	}

	it("borrows nothing when the reference names a different repo", () => {
		// Standing in one checkout says nothing about where another repo
		// lives, and attaching the wrong path would have a round review the
		// wrong code while reporting the right change.
		const claimed = claimGitHubReference(
			"Jitsusama/agentic-harness.pi#424",
			SOMEWHERE_ELSE,
		);

		expect(claimed?.repo.key).toBe("github:Jitsusama/agentic-harness.pi");
		expect(claimed?.repo.localPath).toBeUndefined();
		expect(claimed?.repo.remoteUrl).toBeUndefined();
	});

	it("is unbothered by having nothing to borrow from", () => {
		const claimed = claimGitHubReference("Jitsusama/agentic-harness.pi#424");

		expect(claimed?.repo.key).toBe("github:Jitsusama/agentic-harness.pi");
		expect(claimed?.repo.localPath).toBeUndefined();
	});

	it("gives a bare number the whole repo it was read against", () => {
		// Written expecting this form to pass already, since it cannot be
		// understood without the probe. It failed: the owner and name were
		// read off the probe and the locator rebuilt from just those, so the
		// checkout was dropped on the way through.
		const claimed = claimGitHubReference("424", STANDING_IN);

		expect(claimed?.repo.localPath).toBe(STANDING_IN.localPath);
		expect(claimed?.label).toBe("Jitsusama/agentic-harness.pi#424");
	});
});

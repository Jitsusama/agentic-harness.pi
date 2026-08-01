import { describe, expect, it } from "vitest";
import { repoElsewhere } from "../../../lib/review/elsewhere";

describe("telling a checkout apart from the repo in play", () => {
	it("says nothing when the remote names the same repo", () => {
		expect(
			repoElsewhere("git@github.com:shop/world.git", "github:shop/world"),
		).toBeUndefined();
	});

	it("reports both names when they differ", () => {
		const out = repoElsewhere(
			"git@github.com:Jitsusama/agentic-harness.pi.git",
			"github:shop/world",
		);

		expect(out).toEqual({
			checkout: "git@github.com:Jitsusama/agentic-harness.pi",
			repo: "github:shop/world",
		});
	});

	it("treats a trailing .git and slash as spellings, not differences", () => {
		expect(
			repoElsewhere("https://github.com/shop/world/", "github:shop/world"),
		).toBeUndefined();
	});

	it("ignores case, since a remote and a key need not agree on it", () => {
		expect(
			repoElsewhere("git@github.com:Shop/World.git", "github:shop/world"),
		).toBeUndefined();
	});

	it("says nothing about a local repo, which names no remote to compare", () => {
		// A local range is reviewed where it sits, so there is no second
		// place it could have meant.
		expect(
			repoElsewhere("git@github.com:shop/world.git", "local:/tmp/x"),
		).toBeUndefined();
	});

	it("says nothing when there is no remote to compare against", () => {
		expect(repoElsewhere(undefined, "github:shop/world")).toBeUndefined();
		expect(repoElsewhere("", "github:shop/world")).toBeUndefined();
	});

	it("says nothing when the key carries no slug", () => {
		expect(repoElsewhere("git@github.com:shop/world.git", "github:")).toBe(
			undefined,
		);
	});

	it("keeps a slug containing a colon whole", () => {
		// A key is provider:slug, and a slug may itself contain a colon, so
		// splitting on the first one and rejoining the rest is the rule.
		expect(
			repoElsewhere("https://host/a:b/c", "meteorite:a:b/c"),
		).toBeUndefined();
	});
});

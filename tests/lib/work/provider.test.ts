import { describe, expect, it } from "vitest";
import type { RepoLocator } from "../../../lib/review/index.js";
import {
	chooseTreeProvider,
	type TreeProviderInfo,
} from "../../../lib/work/provider.js";

const world: RepoLocator = {
	key: "github:Shopify/world",
	localPath: "/Users/someone/world/trees/root/src",
};
const elsewhere: RepoLocator = { key: "github:Jitsusama/other" };

/** A provider that applies to whichever repo keys it names. */
const provider = (
	id: string,
	specificity: number,
	...applies: string[]
): TreeProviderInfo => ({
	id,
	specificity,
	appliesTo: (repo) => applies.includes(repo.key),
});

/** The general case: applies to everything, least specific. */
const anyRepo = (id: string): TreeProviderInfo => ({
	id,
	specificity: 0,
	appliesTo: () => true,
});

describe("chooseTreeProvider", () => {
	it("chooses the only provider that applies", () => {
		const choice = chooseTreeProvider([anyRepo("git-worktree")], world);

		expect(choice).toEqual({
			kind: "chosen",
			provider: expect.objectContaining({ id: "git-worktree" }),
		});
	});

	it("skips providers that do not apply to this repo", () => {
		const choice = chooseTreeProvider(
			[
				provider("dev-tree", 50, "github:Shopify/world"),
				anyRepo("git-worktree"),
			],
			elsewhere,
		);

		expect(choice).toEqual({
			kind: "chosen",
			provider: expect.objectContaining({ id: "git-worktree" }),
		});
	});

	it("prefers the more specific provider", () => {
		// The specialisation exists precisely to take over from the
		// general case, so it has to win when both could serve.
		const choice = chooseTreeProvider(
			[
				anyRepo("git-worktree"),
				provider("dev-tree", 50, "github:Shopify/world"),
			],
			world,
		);

		expect(choice).toEqual({
			kind: "chosen",
			provider: expect.objectContaining({ id: "dev-tree" }),
		});
	});

	it("does not depend on the order providers were registered in", () => {
		const general = anyRepo("git-worktree");
		const special = provider("dev-tree", 50, "github:Shopify/world");

		expect(chooseTreeProvider([general, special], world)).toEqual(
			chooseTreeProvider([special, general], world),
		);
	});

	it("reports that nothing applies rather than inventing a provider", () => {
		const choice = chooseTreeProvider(
			[provider("dev-tree", 50, "github:Shopify/world")],
			elsewhere,
		);

		expect(choice).toEqual({ kind: "none" });
	});

	it("reports an empty roster as nothing applying", () => {
		expect(chooseTreeProvider([], world)).toEqual({ kind: "none" });
	});

	it("refuses to settle a tie by array order, and names both", () => {
		// Two providers claiming the same repo at the same
		// specificity is a configuration mistake. Picking whichever
		// registered first hides it, and the symptom would be a
		// tree cut by the wrong provider, which still works well
		// enough to go unnoticed.
		const choice = chooseTreeProvider(
			[
				provider("dev-tree", 50, "github:Shopify/world"),
				provider("other-tree", 50, "github:Shopify/world"),
			],
			world,
		);

		expect(choice.kind).toBe("ambiguous");
		expect(
			choice.kind === "ambiguous" ? choice.providers.map((p) => p.id) : [],
		).toEqual(["dev-tree", "other-tree"]);
	});

	it("names an ambiguity the same way whichever order they registered in", () => {
		const a = provider("dev-tree", 50, "github:Shopify/world");
		const b = provider("other-tree", 50, "github:Shopify/world");

		expect(chooseTreeProvider([b, a], world)).toEqual(
			chooseTreeProvider([a, b], world),
		);
	});

	it("ignores a tie below the winner", () => {
		// Two general providers tying does not make the choice
		// ambiguous when something more specific applies.
		const choice = chooseTreeProvider(
			[
				anyRepo("git-worktree"),
				anyRepo("other-general"),
				provider("dev-tree", 50, "github:Shopify/world"),
			],
			world,
		);

		expect(choice).toEqual({
			kind: "chosen",
			provider: expect.objectContaining({ id: "dev-tree" }),
		});
	});

	it("reports a tie among general providers when nothing more specific applies", () => {
		const choice = chooseTreeProvider(
			[anyRepo("git-worktree"), anyRepo("other-general")],
			world,
		);

		expect(choice.kind).toBe("ambiguous");
	});
});

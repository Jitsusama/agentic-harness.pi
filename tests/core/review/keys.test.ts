import { describe, expect, it } from "vitest";
import {
	type ChangeRef,
	changeKey,
	type RepoLocator,
	type ReviewTarget,
	repoKey,
	targetKey,
} from "../../../lib/core/review/index.ts";
import { changeFileName } from "../../../lib/core/review/keys.ts";

const world: RepoLocator = {
	key: "gitstream:shop/world",
	remoteUrl: "https://gitstream.shopify.io/shop/world.git",
};

const proposal: ReviewTarget = {
	kind: "change",
	change: {
		provider: "meteorite",
		repo: world,
		id: "2000970",
		label: "shop/world#2000970",
	},
};

describe("changeFileName", () => {
	/** A range read from a tree nested as deep as the work layer cuts them. */
	const deep = (head: string): ChangeRef => {
		const root = `/home/someone/.local/state/pi/agentic-harness.pi/work/trees/worktree-github-Someone-core.nix-${"a-long-branch-name-".repeat(4)}`;
		return {
			provider: "local-range",
			repo: { key: `local:${root}`, localPath: root },
			id: `origin/main..${head}`,
			label: head,
		};
	};

	it("folds a key that fits, as records already on disk are named", () => {
		const name = changeFileName({
			provider: "meteorite",
			repo: world,
			id: "2000970",
			label: "shop/world#2000970",
		});
		expect(name, "a short key keeps the name it always had").toBe(
			"meteorite_gitstream_shop_world_2000970.json",
		);
	});

	it("keeps a long key within a file name, leaving room it is asked for", () => {
		const name = changeFileName(deep("topic"), 49);
		expect(
			name.length,
			`${name} leaves 49 bytes of a 255-byte name for a pending suffix`,
		).toBeLessThanOrEqual(255 - 49);
		expect(name, "it is still one safe file name ending in .json").toMatch(
			/^[A-Za-z0-9._-]+\.json$/,
		);
	});

	it("names two long keys sharing a front past the cut as two files", () => {
		const one = changeFileName(deep("topic-one"), 49);
		const two = changeFileName(deep("topic-two"), 49);
		const shortened = /^(.+)-[0-9a-f]{16}\.json$/;
		expect(one, `${one} is cut and ends in a hash`).toMatch(shortened);
		expect(two, `${two} is cut and ends in a hash`).toMatch(shortened);
		expect(
			one.match(shortened)?.[1],
			"the two keep the same front, since they differ only past the cut",
		).toBe(two.match(shortened)?.[1]);
		expect(one, "their hashes tell them apart").not.toBe(two);
	});

	it("keeps a name exactly as long as the room left, and cuts one longer", () => {
		const plain = (head: string) => changeFileName({ ...deep(head), id: head });
		const padding = 255 - 49 - plain("").length;
		const fits = "x".repeat(padding);
		expect(
			changeFileName({ ...deep(fits), id: fits }, 49),
			"a name of exactly 206 bytes is kept as it folds",
		).toBe(plain(fits));
		const over = `${fits}x`;
		expect(
			changeFileName({ ...deep(over), id: over }, 49),
			"a name one byte longer is cut to 206 and ends in a hash",
		).toMatch(/^.{184}-[0-9a-f]{16}\.json$/);
	});

	it("refuses room that leaves no space for a name", () => {
		expect(
			() => changeFileName(deep("topic"), 240),
			"a spare that leaves less than a hash and .json is refused",
		).toThrow(/has no room for a ledger's name/);
	});
});

describe("repoKey", () => {
	it("uses the locator's own key", () => {
		expect(repoKey(world)).toBe("gitstream:shop/world");
	});
});

describe("changeKey", () => {
	it("scopes the change to its provider and repo", () => {
		const ref: ChangeRef = {
			provider: "meteorite",
			repo: world,
			id: "2000970",
			label: "shop/world#2000970",
		};
		expect(changeKey(ref)).toBe("meteorite/gitstream:shop~world/2000970");
	});

	it("distinguishes the same id under different providers", () => {
		const github: ChangeRef = {
			provider: "github",
			repo: { key: "github:Shopify/world" },
			id: "2000970",
			label: "Shopify/world#2000970",
		};
		const meteorite: ChangeRef = {
			provider: "meteorite",
			repo: world,
			id: "2000970",
			label: "shop/world#2000970",
		};
		expect(changeKey(github)).not.toBe(changeKey(meteorite));
	});
});

describe("targetKey", () => {
	it("keys a hosted proposal by its change", () => {
		expect(targetKey(proposal)).toBe(
			"proposal/meteorite/gitstream:shop~world/2000970",
		);
	});

	it("keys a local range by its endpoints", () => {
		const range: ReviewTarget = {
			kind: "range",
			repo: { key: "local:/Users/j/src/app" },
			base: "main",
			head: "feature/thing",
		};
		expect(targetKey(range)).toBe(
			"range/local:~Users~j~src~app/main..feature~thing",
		);
	});

	it("keys a local stack by its ordered refs", () => {
		const stack: ReviewTarget = {
			kind: "stack",
			repo: { key: "local:/repo" },
			refs: ["refs/heads/one", "refs/heads/two"],
		};
		expect(targetKey(stack)).toBe(
			"stack/local:~repo/refs~heads~one+refs~heads~two",
		);
	});

	it("never collides across target kinds over the same repo", () => {
		const repo: RepoLocator = { key: "local:/repo" };
		const asRange: ReviewTarget = {
			kind: "range",
			repo,
			base: "main",
			head: "topic",
		};
		const asStack: ReviewTarget = {
			kind: "stack",
			repo,
			refs: ["topic"],
		};
		expect(targetKey(asRange)).not.toBe(targetKey(asStack));
	});

	it("keys each path segment without stray separators", () => {
		const key = targetKey({
			kind: "range",
			repo: { key: "local:/a/b" },
			base: "refs/heads/main",
			head: "refs/heads/x",
		});
		expect(key).toBe("range/local:~a~b/refs~heads~main..refs~heads~x");
		expect(key.split("/")).toHaveLength(3);
	});
});

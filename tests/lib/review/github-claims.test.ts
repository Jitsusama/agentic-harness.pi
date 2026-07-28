import { describe, expect, it } from "vitest";
import { createGitHubProvider, type ReviewProvider } from "../../../lib/review";

const provider: ReviewProvider = createGitHubProvider({
	exec: async () => ({ code: 0, stdout: "", stderr: "" }),
});

const repo = { key: "github:Shopify/world" };

describe("the GitHub provider's identity", () => {
	it("is called github and claims after any specialist", () => {
		expect(provider.id).toBe("github");
		expect(provider.priority).toBeGreaterThan(0);
	});
});

describe("claiming a reference", () => {
	it("reads a pull request URL", () => {
		const change = provider.claimReference(
			"https://github.com/Shopify/world/pull/123",
		);
		expect(change).toEqual({
			provider: "github",
			repo: { key: "github:Shopify/world" },
			id: "123",
			label: "Shopify/world#123",
		});
	});

	it("labels the change the way a person would write it", () => {
		// The label rides on the reference so a consumer can
		// name a change after reloading it from disk, without
		// a live provider or a request.
		const fromUrl = provider.claimReference(
			"https://github.com/Shopify/world/pull/123",
		);
		const fromShortForm = provider.claimReference("Shopify/world#123");
		const fromNumber = provider.claimReference("123", repo);
		expect(fromUrl?.label).toBe("Shopify/world#123");
		expect(fromShortForm?.label).toBe("Shopify/world#123");
		expect(fromNumber?.label).toBe("Shopify/world#123");
	});

	it("reads a URL with a trailing path or query", () => {
		const change = provider.claimReference(
			"https://github.com/Shopify/world/pull/123/files?w=1",
		);
		expect(change?.id).toBe("123");
	});

	it("reads a Graphite URL, since it is a view onto the same PR", () => {
		const change = provider.claimReference(
			"https://app.graphite.com/github/pr/Shopify/world/123",
		);
		expect(change?.repo.key).toBe("github:Shopify/world");
		expect(change?.id).toBe("123");
	});

	it("reads the owner/repo#number short form", () => {
		expect(provider.claimReference("Shopify/world#123")?.id).toBe("123");
	});

	it("reads a bare number when the repo is known", () => {
		const change = provider.claimReference("123", repo);
		expect(change?.repo.key).toBe("github:Shopify/world");
		expect(change?.id).toBe("123");
	});

	it("reads a number written with a hash", () => {
		expect(provider.claimReference("#123", repo)?.id).toBe("123");
	});

	it("refuses a bare number with no repo to attach it to", () => {
		expect(provider.claimReference("123")).toBeNull();
	});

	it("refuses a bare number against a repo it does not own", () => {
		expect(
			provider.claimReference("123", { key: "gitstream:shop/world" }),
		).toBeNull();
	});

	it("ignores surrounding whitespace", () => {
		expect(provider.claimReference("  Shopify/world#7  ")?.id).toBe("7");
	});

	it("claims nothing it does not recognize", () => {
		for (const input of [
			"https://meteorite.shopify.io/repos/shop/world/pulls/2000970",
			"https://github.com/Shopify/world/issues/5",
			"refs/heads/topic",
			"",
		]) {
			expect(provider.claimReference(input)).toBeNull();
		}
	});
});

describe("claiming a repo", () => {
	it("reads an https remote", () => {
		const claimed = provider.claimRepo({
			remoteUrls: ["https://github.com/Shopify/world.git"],
		});
		expect(claimed?.key).toBe("github:Shopify/world");
	});

	it("reads an ssh remote", () => {
		const claimed = provider.claimRepo({
			remoteUrls: ["git@github.com:Shopify/world.git"],
		});
		expect(claimed?.key).toBe("github:Shopify/world");
	});

	it("reads a remote carrying credentials", () => {
		const claimed = provider.claimRepo({
			remoteUrls: ["https://x-access-token:secret@github.com/Shopify/world"],
		});
		expect(claimed?.key).toBe("github:Shopify/world");
	});

	it("keeps the checkout path and remote it was given", () => {
		const claimed = provider.claimRepo({
			repoRoot: "/src/world",
			remoteUrls: ["git@github.com:Shopify/world.git"],
		});
		expect(claimed?.localPath).toBe("/src/world");
		expect(claimed?.remoteUrl).toBe("git@github.com:Shopify/world.git");
	});

	it("takes the first github remote when several are configured", () => {
		const claimed = provider.claimRepo({
			remoteUrls: [
				"git@gitstream.shopify.io:shop/world.git",
				"git@github.com:Shopify/world.git",
			],
		});
		expect(claimed?.key).toBe("github:Shopify/world");
	});

	it("claims nothing for a repo hosted elsewhere", () => {
		expect(
			provider.claimRepo({
				remoteUrls: ["git@gitlab.com:group/thing.git"],
			}),
		).toBeNull();
		expect(provider.claimRepo({ repoRoot: "/src/thing" })).toBeNull();
	});
});

describe("what the GitHub provider says it can do", () => {
	const capabilities = provider.capabilities(repo);

	it("batches anchored comments into one review", () => {
		expect(capabilities.conversation?.anchoredBatchReview).toBe(true);
		expect(capabilities.conversation?.multiLineRanges).toBe(true);
		expect(capabilities.conversation?.fileLevelComments).toBe(true);
	});

	it("flags a stranded anchor rather than pinning it", () => {
		expect(capabilities.conversation?.staleness).toBe("flagged");
	});

	it("offers the eight reactions GitHub accepts", () => {
		expect(capabilities.conversation?.reactions).toHaveLength(8);
	});

	it("cannot thread a reply onto a top-level message", () => {
		expect(capabilities.conversation?.topLevelThreading).toBe(false);
	});

	it("only ever derives a stack, because GitHub records none", () => {
		expect(capabilities.stacking?.provenance).toBe("derived");
	});

	it("allows only a comment verdict on your own change", () => {
		expect(capabilities.conversation?.selfVerdicts).toEqual(["comment"]);
	});
});

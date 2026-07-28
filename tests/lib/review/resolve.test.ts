import { afterEach, describe, expect, it } from "vitest";
import {
	clearReviewProviders,
	type ReviewConfig,
	registerReviewProvider,
	resolveReference,
} from "../../../lib/review";
import { claimingProvider, stubProvider } from "./support/stub-provider.js";

const world = { key: "gitstream:shop/world" };
const mirror = { key: "github:Shopify/world" };

/** A checkout of shop/world, as the resolver would probe it. */
const inWorld = {
	repoRoot: "/Users/j/world/trees/root/src",
	remoteUrls: ["https://github.com/Shopify/world.git"],
};

afterEach(() => clearReviewProviders());

describe("resolveReference", () => {
	it("refuses when nothing is registered, and says so", () => {
		const result = resolveReference("2000970");
		expect(result.resolved).toBe(false);
		expect(!result.resolved && result.reason).toBe("no-providers");
		expect(!result.resolved && result.message).toMatch(/no review provider/i);
	});

	it("resolves through the only provider that claims", () => {
		registerReviewProvider(claimingProvider("github", 100, mirror));
		const result = resolveReference("Shopify/world#12");
		expect(result.resolved && result.provider.id).toBe("github");
		expect(result.resolved && result.via).toBe("claim");
		expect(result.resolved && result.change.repo.key).toBe(
			"github:Shopify/world",
		);
	});

	it("prefers the lower priority when two providers claim", () => {
		registerReviewProvider(claimingProvider("github", 100, mirror));
		registerReviewProvider(claimingProvider("meteorite", 50, world));
		const result = resolveReference("2000970");
		expect(result.resolved && result.provider.id).toBe("meteorite");
	});

	it("tells each provider what it makes of the checkout", () => {
		// A bare number means "in this repo", so a provider needs
		// its own reading of the checkout to interpret one.
		const seen: (string | undefined)[] = [];
		registerReviewProvider(
			stubProvider({
				id: "forge",
				priority: 100,
				claimRepo: () => mirror,
				claimReference: (input, repo) => {
					seen.push(repo?.key);
					return repo ? { provider: "forge", repo, id: input } : null;
				},
			}),
		);
		const result = resolveReference("123", { probe: inWorld });
		expect(seen).toEqual(["github:Shopify/world"]);
		expect(result.resolved && result.change.repo.key).toBe(
			"github:Shopify/world",
		);
	});

	it("passes no repo when the question came from nowhere", () => {
		const seen: (string | undefined)[] = [];
		registerReviewProvider(
			stubProvider({
				id: "forge",
				priority: 100,
				claimRepo: () => mirror,
				claimReference: (_input, repo) => {
					seen.push(repo?.key);
					return null;
				},
			}),
		);
		resolveReference("123");
		expect(seen).toEqual([undefined]);
	});

	it("skips a provider that does not recognize the reference", () => {
		registerReviewProvider(stubProvider({ id: "blind", priority: 10 }));
		registerReviewProvider(claimingProvider("github", 100, mirror));
		const result = resolveReference("Shopify/world#12");
		expect(result.resolved && result.provider.id).toBe("github");
	});

	describe("with a repo mapped in config", () => {
		const config: ReviewConfig = {
			repos: [{ match: "Shopify/world", providers: ["meteorite", "github"] }],
		};

		it("hands the repo to the mapped provider over priority order", () => {
			registerReviewProvider(claimingProvider("github", 10, mirror));
			registerReviewProvider(claimingProvider("meteorite", 900, world));
			const result = resolveReference("2000970", {
				config,
				probe: inWorld,
			});
			expect(result.resolved && result.provider.id).toBe("meteorite");
			expect(result.resolved && result.via).toBe("config-repo");
		});

		it("falls to the next mapped provider when the first is absent", () => {
			registerReviewProvider(claimingProvider("github", 900, mirror));
			const result = resolveReference("2000970", {
				config,
				probe: inWorld,
			});
			expect(result.resolved && result.provider.id).toBe("github");
			expect(result.resolved && result.via).toBe("config-repo");
		});

		it("ignores the mapping when the probe is a different repo", () => {
			registerReviewProvider(claimingProvider("github", 100, mirror));
			registerReviewProvider(claimingProvider("meteorite", 900, world));
			const result = resolveReference("12", {
				config,
				probe: { repoRoot: "/src/other", remoteUrls: ["git@x:me/other"] },
			});
			expect(result.resolved && result.provider.id).toBe("github");
			expect(result.resolved && result.via).toBe("claim");
		});

		it("tries a later mapped provider when an earlier one is blind", () => {
			// Present but unable to read this reference: the
			// mapping should move on rather than be consumed.
			registerReviewProvider(stubProvider({ id: "meteorite", priority: 5 }));
			registerReviewProvider(claimingProvider("github", 900, mirror));
			const result = resolveReference("2000970", {
				config,
				probe: inWorld,
			});
			expect(result.resolved && result.provider.id).toBe("github");
			expect(result.resolved && result.via).toBe("config-repo");
		});

		it("falls through to claim order when no mapped provider claims", () => {
			const onlyMeteorite: ReviewConfig = {
				repos: [{ match: "Shopify/world", providers: ["meteorite"] }],
			};
			registerReviewProvider(stubProvider({ id: "meteorite", priority: 5 }));
			registerReviewProvider(claimingProvider("github", 900, mirror));
			const result = resolveReference("2000970", {
				config: onlyMeteorite,
				probe: inWorld,
			});
			expect(result.resolved && result.provider.id).toBe("github");
			expect(result.resolved && result.via).toBe("claim");
		});
	});

	describe("with a reference shape mapped in config", () => {
		it("catches a shape no provider recognizes", () => {
			registerReviewProvider(claimingProvider("meteorite", 50, world));
			const blind = stubProvider({ id: "meteorite", priority: 50 });
			clearReviewProviders();
			registerReviewProvider(blind);
			const config: ReviewConfig = {
				references: [
					{
						pattern: "^cr/(?<repo>[^/]+)/(?<id>\\d+)$",
						provider: "meteorite",
					},
				],
			};
			const result = resolveReference("cr/world/2000970", { config });
			expect(result.resolved && result.via).toBe("config-reference");
			expect(result.resolved && result.change).toEqual({
				provider: "meteorite",
				repo: { key: "world" },
				id: "2000970",
			});
		});

		it("uses the configured repo when the pattern names no repo", () => {
			registerReviewProvider(stubProvider({ id: "meteorite", priority: 50 }));
			const config: ReviewConfig = {
				references: [
					{
						pattern: "^pull-(?<id>\\d+)$",
						provider: "meteorite",
						repo: "gitstream:shop/world",
					},
				],
			};
			const result = resolveReference("pull-42", { config });
			expect(result.resolved && result.change).toEqual({
				provider: "meteorite",
				repo: { key: "gitstream:shop/world" },
				id: "42",
			});
		});

		it("ignores a mapping whose provider is not registered", () => {
			registerReviewProvider(claimingProvider("github", 100, mirror));
			const config: ReviewConfig = {
				references: [
					{ pattern: "^x(?<id>\\d+)$", provider: "absent", repo: "r" },
				],
			};
			const result = resolveReference("x1", { config });
			expect(result.resolved && result.provider.id).toBe("github");
		});

		it("does not let a mapping override a provider that claims", () => {
			registerReviewProvider(claimingProvider("github", 100, mirror));
			registerReviewProvider(stubProvider({ id: "meteorite", priority: 5 }));
			const config: ReviewConfig = {
				references: [{ pattern: "^\\d+$", provider: "meteorite", repo: "r" }],
			};
			const result = resolveReference("12", { config });
			expect(result.resolved && result.provider.id).toBe("github");
			expect(result.resolved && result.via).toBe("claim");
		});
	});

	it("refuses an unrecognized reference, naming what was asked", () => {
		registerReviewProvider(stubProvider({ id: "github", priority: 100 }));
		registerReviewProvider(stubProvider({ id: "git", priority: 900 }));
		const result = resolveReference("what is this");
		expect(!result.resolved && result.reason).toBe("unclaimed");
		expect(!result.resolved && result.tried).toEqual(["github", "git"]);
		expect(!result.resolved && result.message).toMatch(/review\.references/);
	});

	it("names a mapped provider that never registered", () => {
		registerReviewProvider(stubProvider({ id: "github", priority: 100 }));
		const config: ReviewConfig = {
			repos: [{ match: "Shopify/world", providers: ["meteorite"] }],
		};
		const result = resolveReference("2000970", { config, probe: inWorld });
		expect(!result.resolved && result.message).toMatch(/meteorite/);
	});
});

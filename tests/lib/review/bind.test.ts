import { afterEach, describe, expect, it } from "vitest";
import {
	bindTarget,
	clearReviewProviders,
	clearTargetBindings,
	type ReviewConfig,
	type ReviewTarget,
	registerReviewProvider,
	resolveTarget,
	unregisterReviewProvider,
} from "../../../lib/review";
import { claimingProvider, stubProvider } from "./support/stub-provider.js";

const world = { key: "gitstream:shop/world" };
const mirror = { key: "github:Shopify/world" };

const hosted: ReviewTarget = {
	kind: "proposal",
	change: {
		provider: "meteorite",
		repo: world,
		id: "2000970",
		label: "shop/world#2000970",
	},
};

const localRange: ReviewTarget = {
	kind: "range",
	repo: { key: "local:/src/app", localPath: "/src/app" },
	base: "main",
	head: "topic",
};

afterEach(() => {
	clearReviewProviders();
	clearTargetBindings();
});

describe("resolveTarget", () => {
	it("refuses when the target's provider is not registered", () => {
		const result = resolveTarget(hosted);
		expect(result.resolved).toBe(false);
		expect(!result.resolved && result.message).toMatch(/meteorite/);
	});

	it("takes the provider a hosted change already names", () => {
		registerReviewProvider(claimingProvider("meteorite", 50, world));
		registerReviewProvider(claimingProvider("github", 10, mirror));
		const result = resolveTarget(hosted);
		expect(result.resolved && result.provider.id).toBe("meteorite");
	});

	it("claims a local target by its repo", () => {
		registerReviewProvider(
			stubProvider({
				id: "git",
				priority: 900,
				claimRepo: (probe) =>
					probe.repoRoot ? { key: `local:${probe.repoRoot}` } : null,
			}),
		);
		const result = resolveTarget(localRange);
		expect(result.resolved && result.provider.id).toBe("git");
	});

	it("prefers a repo mapping over claim order for a local target", () => {
		const config: ReviewConfig = {
			repos: [{ match: "/src/app", providers: ["special"] }],
		};
		registerReviewProvider(
			stubProvider({
				id: "git",
				priority: 10,
				claimRepo: () => ({ key: "local:/src/app" }),
			}),
		);
		registerReviewProvider(
			stubProvider({
				id: "special",
				priority: 900,
				claimRepo: () => ({ key: "local:/src/app" }),
			}),
		);
		const result = resolveTarget(localRange, { config });
		expect(result.resolved && result.provider.id).toBe("special");
	});

	it("keeps the provider a target was bound to", () => {
		registerReviewProvider(claimingProvider("meteorite", 50, world));
		registerReviewProvider(claimingProvider("github", 10, mirror));
		bindTarget(hosted, "github");
		const result = resolveTarget(hosted);
		expect(result.resolved && result.provider.id).toBe("github");
	});

	it("remembers what it resolved so a later registration cannot flip it", () => {
		registerReviewProvider(
			stubProvider({
				id: "git",
				priority: 900,
				claimRepo: () => ({ key: "local:/src/app" }),
			}),
		);
		const first = resolveTarget(localRange);
		expect(first.resolved && first.provider.id).toBe("git");

		// A specialist arrives mid-session and would out-claim
		// the generalist, but this target is already bound.
		registerReviewProvider(
			stubProvider({
				id: "specialist",
				priority: 1,
				claimRepo: () => ({ key: "local:/src/app" }),
			}),
		);
		const second = resolveTarget(localRange);
		expect(second.resolved && second.provider.id).toBe("git");
	});

	it("reports the claimed repo on a remembered call, not the local locator", () => {
		// Every other test here has the stub claim the key the target already
		// carries, so a memo that replayed the target's own locator looked
		// correct. A provider that maps a checkout onto a hosted repo is what
		// tells the two apart, and it is the real case: a local range in a
		// world checkout resolves to a hosted change.
		registerReviewProvider(
			stubProvider({
				id: "meteorite",
				priority: 50,
				claimRepo: () => world,
			}),
		);

		const first = resolveTarget(localRange);
		expect(first.resolved && first.repo.key).toBe(world.key);
		expect(first.resolved && first.via).toBe("claim");

		// The second call is the one that broke: a retry after a refusal
		// handed the provider `local:/src/app`, which it does not serve.
		const second = resolveTarget(localRange);
		expect(second.resolved && second.repo.key).toBe(world.key);
		expect(second.resolved && second.via).toBe("claim");
	});

	it("re-resolves when the bound provider goes away", () => {
		registerReviewProvider(
			stubProvider({
				id: "git",
				priority: 900,
				claimRepo: () => ({ key: "local:/src/app" }),
			}),
		);
		resolveTarget(localRange);
		unregisterReviewProvider("git");
		registerReviewProvider(
			stubProvider({
				id: "other",
				priority: 500,
				claimRepo: () => ({ key: "local:/src/app" }),
			}),
		);
		const result = resolveTarget(localRange);
		expect(result.resolved && result.provider.id).toBe("other");
	});

	it("does not confuse a range with a stack over the same repo", () => {
		registerReviewProvider(
			stubProvider({
				id: "git",
				priority: 900,
				claimRepo: () => ({ key: "local:/src/app" }),
			}),
		);
		registerReviewProvider(
			stubProvider({
				id: "other",
				priority: 500,
				claimRepo: () => ({ key: "local:/src/app" }),
			}),
		);
		bindTarget(localRange, "git");
		const asStack: ReviewTarget = {
			kind: "stack",
			repo: localRange.kind === "range" ? localRange.repo : world,
			refs: ["topic"],
		};
		const result = resolveTarget(asStack);
		expect(result.resolved && result.provider.id).toBe("other");
	});

	it("reports the repo it settled on for a local target", () => {
		registerReviewProvider(
			stubProvider({
				id: "git",
				priority: 900,
				claimRepo: () => ({ key: "local:/src/app", localPath: "/src/app" }),
			}),
		);
		const result = resolveTarget(localRange);
		expect(result.resolved && result.repo.localPath).toBe("/src/app");
	});
});

describe("resolving a local target from what the probe found", () => {
	// The engine probes the checkout, discovers every remote URL, and hands the probe
	// down as context. This asserts the claim actually reads it, which it did not: the
	// probe offered to each provider was rebuilt from the target's own RepoLocator, and
	// the one the engine builds for a local target carries no remote at all. So every
	// provider was asked to claim a checkout with no remotes, and only the provider that
	// claims anything local could answer.
	//
	// The symptom was three steps away and looked like a different bug entirely:
	// `review_offer propose` bound to the plain git provider, which has no authoring
	// facet, so the pivot of the whole arc refused unless you had first attached some
	// other hosted change from the same repo. In a repo with no changes yet there was
	// nothing to attach and no way through at all.
	it("offers the probe's remotes to the provider, not an empty list", () => {
		const seen: string[][] = [];
		registerReviewProvider(
			stubProvider({
				id: "hosted",
				priority: 10,
				claimRepo: (probe) => {
					seen.push([...(probe.remoteUrls ?? [])]);
					return (probe.remoteUrls ?? []).some((url) =>
						url.includes("github.com"),
					)
						? { key: "github:Shopify/world" }
						: null;
				},
			}),
		);

		const resolution = resolveTarget(localRange, {
			probe: {
				repoRoot: "/src/app",
				remoteUrls: ["git@github.com:Shopify/world.git"],
			},
		});

		expect(seen).toEqual([["git@github.com:Shopify/world.git"]]);
		expect(resolution.resolved).toBe(true);
		expect(resolution.resolved && resolution.repo.key).toBe(
			"github:Shopify/world",
		);
	});

	it("falls back to the target's own locator when no probe is given", () => {
		registerReviewProvider(
			claimingProvider("local-ish", 10, { key: "local:/src/app" }),
		);

		expect(resolveTarget(localRange).resolved).toBe(true);
	});
});

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
	change: { provider: "meteorite", repo: world, id: "2000970" },
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

/**
 * A repo pin is honoured as far as it reaches origin: a World checkout
 * with a GitHub mirror beside its Delta origin, pinned to GitHub before
 * the cut-over, still proposes where origin points (15 November, twice).
 */

import { afterEach, describe, expect, it } from "vitest";
import {
	clearReviewProviders,
	clearTargetBindings,
	type ReviewConfig,
	registerReviewProvider,
	resolveRepo,
} from "../../../lib/core/review/index.ts";
import { stubProvider } from "../../support/stub-provider.ts";

const DELTA = "https://delta.example.io/shop/world.git";
const MIRROR = "https://github.com/shop/world.git";

/** A provider claiming any remote on `host`, through that remote. */
function byHost(id: string, priority: number, host: string) {
	return stubProvider({
		id,
		priority,
		claimRepo: (probe) => {
			const url = probe.remoteUrls?.find((one) => one.includes(host));
			return url ? { key: `${id}:shop/world`, remoteUrl: url } : null;
		},
	});
}

const pinnedToMirror: ReviewConfig = {
	repos: [{ match: "shop/world", providers: ["meteorite", "github"] }],
};

afterEach(() => {
	clearReviewProviders();
	clearTargetBindings();
});

describe("a pin that reaches only a mirror", () => {
	it("gives way to the provider that claims origin", () => {
		registerReviewProvider(byHost("github", 100, "github.com"));
		registerReviewProvider(byHost("delta", 40, "delta.example.io"));
		const result = resolveRepo(
			{ repoRoot: "/w", remoteUrls: [DELTA, MIRROR, DELTA], origin: DELTA },
			{ config: pinnedToMirror },
		);

		expect(result.resolved && result.provider.id).toBe("delta");
		expect(result.resolved && result.via).toBe("claim");
	});

	it("stands when nobody claims origin", () => {
		registerReviewProvider(byHost("github", 100, "github.com"));
		const result = resolveRepo(
			{ repoRoot: "/w", remoteUrls: [DELTA, MIRROR], origin: DELTA },
			{ config: pinnedToMirror },
		);

		expect(result.resolved && result.provider.id).toBe("github");
		expect(result.resolved && result.via).toBe("config-repo");
	});

	it("stands when it claims through origin itself, or nothing names origin", () => {
		registerReviewProvider(byHost("github", 100, "github.com"));
		registerReviewProvider(byHost("delta", 40, "delta.example.io"));
		const atOrigin = resolveRepo(
			{ repoRoot: "/w", remoteUrls: [MIRROR, DELTA], origin: MIRROR },
			{ config: pinnedToMirror },
		);
		const noOrigin = resolveRepo(
			{ repoRoot: "/w", remoteUrls: [MIRROR, DELTA] },
			{ config: pinnedToMirror },
		);

		expect(atOrigin.resolved && atOrigin.provider.id).toBe("github");
		expect(noOrigin.resolved && noOrigin.provider.id).toBe("github");
	});
});

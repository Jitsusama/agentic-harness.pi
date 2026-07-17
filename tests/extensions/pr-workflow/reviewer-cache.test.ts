import { describe, expect, it } from "vitest";
import {
	dispatchWithCache,
	isCacheableDispatch,
	type ReviewerDispatchCache,
	reviewerCacheKey,
} from "../../../extensions/pr-workflow/reviewer-cache.js";
import type { RunReviewerResult } from "../../../lib/subagent/subagent.js";

function result(over: Partial<RunReviewerResult> = {}): RunReviewerResult {
	return {
		reviewerId: "alpha",
		exitCode: 0,
		finalAssistantText: "{}",
		stderr: "",
		warnings: [],
		verification: { called: true, ok: true },
		...over,
	};
}

// A council re-run should not pay to re-run a reviewer whose
// input is byte-identical. The cache key is the content, so
// a hit is correct by construction and a changed prompt is a
// miss. Only a verified result is ever stored, so a crash is
// always re-run.

describe("reviewerCacheKey", () => {
	it("is stable for identical input and differs when any part changes", () => {
		const base = { reviewerId: "a", model: "m", charter: "c", prompt: "p" };
		const key = reviewerCacheKey(base);
		expect(reviewerCacheKey({ ...base })).toBe(key);
		expect(reviewerCacheKey({ ...base, prompt: "p2" })).not.toBe(key);
		expect(reviewerCacheKey({ ...base, model: "m2" })).not.toBe(key);
		expect(reviewerCacheKey({ ...base, charter: "c2" })).not.toBe(key);
		expect(reviewerCacheKey({ ...base, reviewerId: "b" })).not.toBe(key);
	});

	it("changes when execution-affecting settings change", () => {
		const base = { reviewerId: "a", model: "m", prompt: "p" };
		const key = reviewerCacheKey(base);
		expect(reviewerCacheKey({ ...base, thinkingLevel: "high" })).not.toBe(key);
		expect(reviewerCacheKey({ ...base, tools: ["read", "bash"] })).not.toBe(
			key,
		);
		expect(reviewerCacheKey({ ...base, thinkingLevel: "high" })).not.toBe(
			reviewerCacheKey({ ...base, thinkingLevel: "low" }),
		);
	});
});

describe("isCacheableDispatch", () => {
	it("caches only a verified result", () => {
		expect(isCacheableDispatch(result())).toBe(true);
		expect(
			isCacheableDispatch(
				result({ verification: { called: true, ok: false } }),
			),
		).toBe(false);
		expect(isCacheableDispatch(result({ verification: undefined }))).toBe(
			false,
		);
	});
});

describe("dispatchWithCache", () => {
	it("returns the cached result and skips dispatch on a hit", async () => {
		const cache: ReviewerDispatchCache = new Map();
		let calls = 0;
		const run = async () => {
			calls++;
			return result({ finalAssistantText: `run-${calls}` });
		};

		const first = await dispatchWithCache(cache, "k", run);
		const second = await dispatchWithCache(cache, "k", run);

		expect(first.fromCache).toBe(false);
		expect(second.fromCache).toBe(true);
		expect(second.value.finalAssistantText).toBe("run-1");
		expect(calls).toBe(1);
	});

	it("does not store an unverified result", async () => {
		const cache: ReviewerDispatchCache = new Map();
		let calls = 0;
		const run = async () => {
			calls++;
			return result({ verification: { called: false, ok: false } });
		};

		await dispatchWithCache(cache, "k", run);
		await dispatchWithCache(cache, "k", run);

		expect(calls).toBe(2);
	});

	it("bypasses the read but still refreshes the store when read is false", async () => {
		const cache: ReviewerDispatchCache = new Map();
		cache.set("k", result({ finalAssistantText: "stale" }));
		let calls = 0;
		const run = async () => {
			calls++;
			return result({ finalAssistantText: "fresh" });
		};

		const refreshed = await dispatchWithCache(cache, "k", run, { read: false });

		expect(refreshed.fromCache).toBe(false);
		expect(calls).toBe(1);
		expect(cache.get("k")?.finalAssistantText).toBe("fresh");
	});
});

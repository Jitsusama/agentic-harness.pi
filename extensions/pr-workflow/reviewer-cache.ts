/**
 * Content-addressed reuse of reviewer dispatches.
 *
 * A council re-run should not pay to re-run a reviewer whose
 * input has not changed. The cache key is the reviewed
 * content itself (reviewer identity, model, charter and the
 * exact prompt, which already encodes the PR diff,
 * description and thread context), so a cache hit means the
 * input is byte-identical and reusing the prior result is
 * correct by construction. A changed diff changes the
 * prompt, changes the key and misses, so a stale review can
 * never be served. Only a verified result is ever stored:
 * re-running a crashed or unverified reviewer is the whole
 * point of a retry.
 */

import { createHash } from "node:crypto";
import type { RunReviewerResult } from "../../lib/subagent/subagent.js";

/** Session cache mapping a content key to a prior dispatch. */
export type ReviewerDispatchCache = Map<string, RunReviewerResult>;

/**
 * Compute the content key for a reviewer dispatch. Stable
 * for identical input; any change to identity, model,
 * charter or prompt yields a different key.
 */
export function reviewerCacheKey(input: {
	reviewerId: string;
	model?: string;
	charter?: string;
	prompt: string;
}): string {
	const material = JSON.stringify({
		id: input.reviewerId,
		model: input.model ?? null,
		charter: input.charter ?? null,
		prompt: input.prompt,
	});
	return createHash("sha256").update(material).digest("hex");
}

/**
 * Whether a dispatch result is worth caching: only a clean,
 * verified result. A crash or a failed verification must be
 * re-run, never reused.
 */
export function isCacheableDispatch(value: RunReviewerResult): boolean {
	return value.verification?.ok === true;
}

/**
 * Return a cached dispatch on a hit, or run and (when
 * cacheable) store the result. Pass `read: false` to bypass
 * the read while still refreshing the store, which a retry
 * uses to overwrite a stale entry with a fresh run.
 */
export async function dispatchWithCache(
	cache: ReviewerDispatchCache | undefined,
	key: string,
	dispatch: () => Promise<RunReviewerResult>,
	opts?: { read?: boolean },
): Promise<{ value: RunReviewerResult; fromCache: boolean }> {
	const read = opts?.read ?? true;
	if (cache && read) {
		const hit = cache.get(key);
		if (hit) return { value: hit, fromCache: true };
	}
	const value = await dispatch();
	if (cache && isCacheableDispatch(value)) cache.set(key, value);
	return { value, fromCache: false };
}

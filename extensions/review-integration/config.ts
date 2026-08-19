/**
 * Reading the `review` section of the package config.
 *
 * Two knobs, both of which exist because guessing which backend
 * owns a repo is worse than being told. A malformed section is
 * reported rather than silently ignored: someone who wrote a
 * mapping and got no mapping deserves to know why.
 *
 * The parsing itself is pure and lives in `agentic-harness.core`,
 * which has no opinion about where the package config file lives
 * or how it is read from disk. This module supplies both.
 */

import type { LoadedReviewConfig } from "@jitsusama/agentic-harness.core/review";
import { parseReviewSection } from "@jitsusama/agentic-harness.core/review";
import { loadPackageConfig } from "../../lib/internal/config/loader.js";

/** Section key for this extension in the package config. */
export const REVIEW_SLUG = "review";

export type { LoadedReviewConfig };

/** Load the review configuration, reporting anything malformed. */
export async function loadReviewConfig(
	// Named for a test, and defaulted for everybody else. The reader
	// is otherwise reachable only through the one path the whole
	// machine shares, which a test can redirect but not isolate.
	path?: string,
): Promise<LoadedReviewConfig> {
	const loaded = await loadPackageConfig(path);
	if (!loaded.ok) {
		return { config: {}, problems: [loaded.error] };
	}
	return parseReviewSection(loaded.config.sections[REVIEW_SLUG]);
}

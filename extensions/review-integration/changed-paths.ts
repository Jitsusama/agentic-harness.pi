/**
 * The paths a merged change touched, for the areas its landing names
 * (lib/internal/session/changed-areas.ts).
 *
 * Read from the provider's own diff route and nothing else. When a
 * backend refuses a big change's diff, the engine's `diff` fetches the
 * change into the local checkout and diffs it against the local base
 * branch, which can be stale and so take in other people's commits, and
 * the fetch runs on after anyone has stopped waiting for it. A change too
 * big for its backend's diff is a sweep, whose areas say little about
 * what its quest works on, so it names none.
 */

import { filePath, parseUnifiedDiff } from "../../lib/core/review/diff.ts";
import type { BoundTarget } from "../../lib/core/review/engine.ts";
import { settledWithin } from "../../lib/internal/settled.ts";

/**
 * The longest a merge's answer, or a look at the queue, waits on a
 * change's diff to say its areas.
 */
export const CHANGED_PATHS_MS = 15_000;

/**
 * The paths `bound`'s change touched, as its provider's diff says within
 * {@link CHANGED_PATHS_MS}; none for a target that isn't a hosted
 * change, or a diff refused or late.
 */
export async function changedPaths(bound: BoundTarget): Promise<string[]> {
	const { target, provider } = bound;
	if (target.kind !== "change" || !provider.changes) return [];
	try {
		const text = await settledWithin(
			provider.changes.diff(target.change),
			CHANGED_PATHS_MS,
		);
		return text === undefined ? [] : parseUnifiedDiff(text).files.map(filePath);
	} catch {
		// Refused, or too big for its backend: it landed all the same, and
		// only what its quest is said to work on misses this one.
		return [];
	}
}

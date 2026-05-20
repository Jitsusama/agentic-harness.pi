/**
 * Shared council test helpers. Kept in `.test-helpers`
 * (not `.test`) so vitest's collector ignores it.
 */

import type { WorktreeProvider } from "../../../extensions/pr-workflow/worktree.js";

/** Worktree provider that hands out deterministic paths without touching disk. */
export function fakeProvider(): WorktreeProvider {
	return {
		id: "fake",
		async ensure(req) {
			return {
				path: `/wt/${req.sha}`,
				sha: req.sha,
				providerId: "fake",
				reusable: true,
				createdAt: new Date(0),
			};
		},
		async release() {},
	};
}

import type { ReviewerCancellationRegistry } from "./cancellation.js";
import type { WorktreeRegistry } from "./worktree.js";

/** Outcome of a worktree reclaim sweep. */
export interface ReclaimResult {
	/** How many handles were active when the sweep began. */
	readonly released: number;
	/** Per-handle release failures, as messages. Empty on a clean sweep. */
	readonly errors: string[];
}

/**
 * Reclaim every worktree the registry holds, safely against
 * in-flight review runs.
 *
 * Cancels any active runs, waits for them to drain so a
 * release never pulls a tree out from under a reviewer, then
 * releases all tracked handles. Release failures are
 * collected rather than thrown, so one stuck tree never
 * blocks the rest or the caller's own teardown.
 */
export async function reclaimWorktrees(
	registry: WorktreeRegistry,
	cancellations: ReviewerCancellationRegistry,
): Promise<ReclaimResult> {
	cancellations.cancel();
	await cancellations.whenIdle();
	const released = registry.active().length;
	const errors = await releaseAllCollecting(registry);
	return { released, errors };
}

async function releaseAllCollecting(
	registry: WorktreeRegistry,
): Promise<string[]> {
	try {
		await registry.releaseAll();
		return [];
	} catch (error) {
		return flattenErrors(error);
	}
}

function flattenErrors(error: unknown): string[] {
	if (error instanceof AggregateError) {
		return error.errors.map(messageOf);
	}
	return [messageOf(error)];
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

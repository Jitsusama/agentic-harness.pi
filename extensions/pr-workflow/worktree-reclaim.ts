import type { ReviewerCancellationRegistry } from "./cancellation.js";
import type { WorktreeRegistry } from "./worktree.js";

/** Outcome of a worktree reclaim sweep. */
export interface ReclaimResult {
	/** How many handles were successfully released. */
	readonly released: number;
	/** Per-handle release failures, as messages. Empty on a clean sweep. */
	readonly errors: string[];
}

/** Options for {@link reclaimWorktrees}. */
export interface ReclaimOptions {
	/**
	 * Upper bound, in milliseconds, on waiting for cancelled runs
	 * to drain before releasing anyway. A reviewer subprocess that
	 * ignores its abort would otherwise hang the drain forever,
	 * wedging session teardown and the quick-mutation lane. Omit
	 * to wait unbounded (only safe when the caller knows runs end).
	 */
	readonly drainTimeoutMs?: number;
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
	options: ReclaimOptions = {},
): Promise<ReclaimResult> {
	cancellations.cancel();
	await drainOrTimeout(cancellations, options.drainTimeoutMs);
	const attempted = registry.active().length;
	const errors = await releaseAllCollecting(registry);
	return { released: attempted - errors.length, errors };
}

/**
 * Wait for active runs to drain, but no longer than
 * `timeoutMs` when one is given. The timer is cleared when the
 * drain wins so it never keeps the event loop alive.
 */
async function drainOrTimeout(
	cancellations: ReviewerCancellationRegistry,
	timeoutMs: number | undefined,
): Promise<void> {
	if (timeoutMs === undefined) {
		await cancellations.whenIdle();
		return;
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, timeoutMs);
	});
	try {
		await Promise.race([cancellations.whenIdle(), timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
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

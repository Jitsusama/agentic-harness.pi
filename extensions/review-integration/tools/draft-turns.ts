/**
 * Whose turn it is to change a draft: one queue per draft target, so
 * `review_draft` calls made at once save one after another rather than
 * over each other.
 *
 * Apart from `draft.ts` because it changes with how a draft is stored
 * and which targets a call touches, not with what any action does.
 */

import {
	type BoundTarget,
	type ReviewTarget,
	targetKey,
} from "../../../lib/core/review/index.ts";
import {
	type AsyncMutex,
	createMutex,
} from "../../../lib/internal/async-mutex.ts";

/**
 * One queue per draft target, for the life of the process.
 *
 * Every call loads its draft, changes it and saves it, so two at once
 * each save over what the other added. Parallel tool calls are the
 * ordinary case, not a rare one: an agent notes several findings in a
 * turn. Never emptied, since a target is a short key and a session
 * reviews a handful.
 */
const turns = new Map<string, AsyncMutex>();

/**
 * Run `fn` holding every one of these targets' turns.
 *
 * Taken in sorted order, so two calls wanting overlapping sets cannot
 * each hold one the other is waiting for. A call stopped while it
 * waits leaves at once, having run nothing.
 */
export async function inTurns<T>(
	keys: readonly string[],
	signal: AbortSignal | undefined,
	fn: () => Promise<T>,
): Promise<T> {
	const ordered = [...new Set(keys)].sort();
	const hold = (at: number): Promise<T> => {
		const key = ordered[at];
		if (key === undefined) return fn();
		let mutex = turns.get(key);
		if (!mutex) {
			mutex = createMutex();
			turns.set(key, mutex);
		}
		return mutex.runExclusive(() => hold(at + 1), signal ? { signal } : {});
	};
	return hold(0);
}

/** Whose turns a call needs: its own target's, or a whole stack's. */
export async function turnsFor(
	action: string,
	target: ReviewTarget,
	bound: BoundTarget | undefined,
): Promise<string[]> {
	if (action === "publish-stack" && bound) return stackKeys(bound);
	return [targetKey(target)];
}

/**
 * The targets a stack publish touches: every change in the stack, and
 * the one it was asked through, which a stack that cannot be read is
 * still about.
 */
async function stackKeys(bound: BoundTarget): Promise<string[]> {
	const stack = await bound.stack();
	const members = (stack?.nodes ?? []).flatMap((node) =>
		node.change === undefined
			? []
			: [targetKey({ kind: "change", change: node.change.ref })],
	);
	return [targetKey(bound.target), ...members];
}

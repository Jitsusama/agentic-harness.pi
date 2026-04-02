/**
 * Shared navigation helpers for review item lists.
 *
 * PR workflow extensions all use navigable lists where the
 * user approves or rejects items, then the cursor advances
 * to the next unresolved one. This module provides the
 * shared logic so the behaviour is identical everywhere.
 */

import type { LifecycleItem } from "./types.js";

/**
 * Advance from the current index to the next item matching
 * the target status. Wraps around the array. Returns the
 * new index, or null if no item matches.
 */
export function advanceToNextWithStatus<T extends LifecycleItem<string>>(
	items: T[],
	currentIndex: number,
	targetStatus: string,
): number | null {
	for (let i = 1; i <= items.length; i++) {
		const next = (currentIndex + i) % items.length;
		if (items[next]?.status === targetStatus) {
			return next;
		}
	}
	return null;
}

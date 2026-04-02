/**
 * Generic CRUD and lifecycle operations for review items.
 *
 * All functions operate on plain arrays of LifecycleItem
 * objects. Extensions own their arrays and item shapes;
 * these helpers provide the shared mechanical operations
 * so every extension handles add/update/remove/stats the
 * same way.
 */

import type { LifecycleItem, StatusStats } from "./types.js";

/** Generate a unique item ID with a domain prefix. */
export function nextId(prefix: string): string {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Add an item to the array with a generated ID.
 * Returns the newly created item.
 */
export function addItem<T extends LifecycleItem<string>>(
	items: T[],
	data: Omit<T, "id">,
	prefix: string,
): T {
	const item = { ...data, id: nextId(prefix) } as T;
	items.push(item);
	return item;
}

/** Find an item by ID, or undefined if not found. */
export function findItem<T extends LifecycleItem<string>>(
	items: T[],
	id: string,
): T | undefined {
	return items.find((item) => item.id === id);
}

/**
 * Update an item's fields by ID. The `id` field cannot be
 * changed. Returns true if the item was found and updated.
 */
export function updateItem<T extends LifecycleItem<string>>(
	items: T[],
	id: string,
	updates: Partial<Omit<T, "id">>,
): boolean {
	const item = findItem(items, id);
	if (!item) return false;
	Object.assign(item, updates);
	return true;
}

/** Remove an item by ID. Returns true if found and removed. */
export function removeItem<T extends LifecycleItem<string>>(
	items: T[],
	id: string,
): boolean {
	const index = items.findIndex((item) => item.id === id);
	if (index === -1) return false;
	items.splice(index, 1);
	return true;
}

/**
 * Remove multiple items by ID. Returns which IDs were
 * removed and which weren't found.
 */
export function removeItems<T extends LifecycleItem<string>>(
	items: T[],
	ids: string[],
): { removed: string[]; notFound: string[] } {
	const removed: string[] = [];
	const notFound: string[] = [];
	for (const id of ids) {
		if (removeItem(items, id)) {
			removed.push(id);
		} else {
			notFound.push(id);
		}
	}
	return { removed, notFound };
}

/**
 * Count items per status. Returns a record keyed by each
 * status value with its count.
 */
export function statusStats<S extends string>(
	items: LifecycleItem<S>[],
	statuses: readonly S[],
): StatusStats<S> {
	const stats = {} as StatusStats<S>;
	for (const s of statuses) {
		stats[s] = 0;
	}
	for (const item of items) {
		if (item.status in stats) {
			stats[item.status]++;
		}
	}
	return stats;
}

/**
 * Promote all items from one status to another.
 * Returns the number of items promoted.
 */
export function promoteStatus<T extends LifecycleItem<string>>(
	items: T[],
	from: string,
	to: string,
): number {
	let count = 0;
	for (const item of items) {
		if (item.status === from) {
			(item as LifecycleItem<string>).status = to;
			count++;
		}
	}
	return count;
}

/**
 * Check whether all items have moved past a given status.
 * Useful for auto-completing tabs when every item has been
 * reviewed.
 */
export function allResolved<T extends LifecycleItem<string>>(
	items: T[],
	unresolvedStatus: string,
): boolean {
	if (items.length === 0) return false;
	return items.every((item) => item.status !== unresolvedStatus);
}

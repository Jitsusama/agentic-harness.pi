/**
 * Shared types for lifecycle-managed review items.
 *
 * Every PR workflow extension manages items (comments,
 * threads, annotations) that follow an ID-based lifecycle
 * with status transitions, CRUD operations and persistence.
 * These types define the minimum contract that the shared
 * operations work against.
 */

/** Minimum shape for a lifecycle-managed item. */
export interface LifecycleItem<S extends string> {
	/** Unique identifier. */
	id: string;
	/** Current lifecycle status. */
	status: S;
}

/** Count of items per status value. */
export type StatusStats<S extends string> = Record<S, number>;

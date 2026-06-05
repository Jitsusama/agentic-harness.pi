/**
 * Structural edits to the quest tree: reparenting and bulk
 * status changes. The planners here are pure: they read an
 * in-memory index and compute what would change, validating
 * scope and refusing cycles, so a caller can preview before it
 * writes and report exactly what moved.
 */

import type { QuestIndex } from "./discovery.js";

/** A single parent change produced by {@link planReparent}. */
export interface ReparentChange {
	id: string;
	oldParent: string | null;
	newParent: string | null;
}

/** The outcome of planning a reparent: moves plus refusals. */
export interface ReparentPlan {
	changes: ReparentChange[];
	errors: string[];
}

/**
 * Plan the parent changes for `targetIds` against `newParent`
 * without touching disk. No-op moves are dropped; missing
 * quests, a missing new parent, self-parenting and cycle-forming
 * moves are reported in `errors`.
 */
export function planReparent(
	index: QuestIndex,
	targetIds: string[],
	newParent: string | null,
): ReparentPlan {
	const changes: ReparentChange[] = [];
	const errors: string[] = [];

	if (newParent !== null && !index.quests.has(newParent)) {
		return { changes: [], errors: [`New parent ${newParent} not found.`] };
	}

	for (const id of targetIds) {
		const entry = index.quests.get(id);
		if (!entry) {
			errors.push(`Quest ${id} not found.`);
			continue;
		}
		if (newParent === id) {
			errors.push(`${id} cannot be its own parent (cycle).`);
			continue;
		}
		if (newParent !== null && isDescendant(index, newParent, id)) {
			errors.push(`Reparenting ${id} under ${newParent} would form a cycle.`);
			continue;
		}
		const oldParent = entry.doc.frontMatter.parent ?? null;
		if (oldParent === newParent) continue;
		changes.push({ id, oldParent, newParent });
	}

	return { changes, errors };
}

/** A single status change produced by {@link planStatusChange}. */
export interface StatusChange {
	id: string;
	oldStatus: string;
	newStatus: string;
}

/** The outcome of planning a bulk status change. */
export interface StatusChangePlan {
	changes: StatusChange[];
	errors: string[];
}

/**
 * Plan the status changes for `targetIds` to `newStatus` without
 * touching disk. Quests already at the target status are dropped;
 * missing quests are reported in `errors`.
 */
export function planStatusChange(
	index: QuestIndex,
	targetIds: string[],
	newStatus: string,
): StatusChangePlan {
	const changes: StatusChange[] = [];
	const errors: string[] = [];
	for (const id of targetIds) {
		const entry = index.quests.get(id);
		if (!entry) {
			errors.push(`Quest ${id} not found.`);
			continue;
		}
		const oldStatus = entry.doc.frontMatter.status;
		if (oldStatus === newStatus) continue;
		changes.push({ id, oldStatus, newStatus });
	}
	return { changes, errors };
}

/**
 * Is `candidate` inside `ancestor`'s subtree? Walks up the parent
 * chain from `candidate`; a visited set keeps pre-existing cyclic
 * data from spinning.
 */
function isDescendant(
	index: QuestIndex,
	candidate: string,
	ancestor: string,
): boolean {
	const seen = new Set<string>();
	let cursor: string | null = candidate;
	while (cursor !== null && !seen.has(cursor)) {
		seen.add(cursor);
		if (cursor === ancestor) return true;
		cursor = index.quests.get(cursor)?.doc.frontMatter.parent ?? null;
	}
	return false;
}

/**
 * The paragraphs a compaction could quote: every tagged paragraph with
 * a kind, from the entries the compaction drops, each said once.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { SELECTION_KINDS, type SelectionKind } from "./kinds.ts";
import type { TagIndex } from "./tags.ts";
import { type SelectionUnit, unitsOf } from "./units.ts";

/** A paragraph that could be quoted. */
export interface Candidate {
	readonly unit: SelectionUnit;
	/** The kind it is quoted under: the most durable it was tagged with. */
	readonly kind: SelectionKind;
	/** Its position on the branch; higher is more recent. */
	readonly order: number;
}

/**
 * Every tagged paragraph before `firstKeptEntryId`, the entry from which
 * the conversation stays verbatim, or across the whole branch when that
 * entry is not on it. A paragraph said more than once is the latest
 * saying of it, which is where it last mattered.
 */
export function candidatesBefore(
	branch: readonly SessionEntry[],
	tags: TagIndex,
	firstKeptEntryId: string | undefined,
): Candidate[] {
	const latest = new Map<string, Candidate>();
	let order = 0;
	for (const entry of branch) {
		if (entry.id === firstKeptEntryId) break;
		for (const unit of unitsOf(entry)) {
			order += 1;
			const kind = mostDurable(tags.kinds.get(unit.hash));
			if (!kind) continue;
			latest.delete(unit.hash);
			latest.set(unit.hash, { unit, kind, order });
		}
	}
	return [...latest.values()];
}

function mostDurable(
	kinds: readonly SelectionKind[] | undefined,
): SelectionKind | undefined {
	if (!kinds || kinds.length === 0) return undefined;
	return SELECTION_KINDS.find((kind) => kinds.includes(kind));
}

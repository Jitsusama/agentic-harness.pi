/**
 * The tags the selection records on the session: for one message, the
 * kinds each of its paragraphs was found to be, with what finding them
 * cost.
 *
 * They are custom entries so they persist with the session and cost
 * nothing in the conversation: a custom entry is never sent to the
 * model. The usage is recorded on the entry because the ledger bills a
 * custom entry that carries its own usage as a side call.
 *
 * A paragraph is known by its text, not by where it sits. The entry id
 * a record names is kept, but what a tag is read back by is the
 * paragraph's hash, so tags survive a host that rebuilds the session
 * with new ids, and a paragraph said twice is tagged once.
 */

import type { Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { isSelectionKind, type SelectionKind } from "./kinds.ts";
import { unitsOf } from "./units.ts";

/** The custom entry type a message's tags are recorded under. */
export const SELECTION_TAGS_ENTRY = "compaction-selection-tags";

/** One paragraph's kinds, by its hash. */
export interface UnitTags {
	readonly hash: string;
	readonly kinds: readonly SelectionKind[];
}

/** One message's tags, as recorded. */
export interface SelectionTags {
	/** The message entry the tags are about. */
	readonly entryId: string;
	/**
	 * Every paragraph that was asked about, kinds or none. A failure
	 * lists its paragraphs with no kinds, so they are not asked again.
	 */
	readonly units: readonly UnitTags[];
	/** The model that answered. */
	readonly model?: string;
	readonly usage?: Usage;
	/** Why tagging failed, when it did; its paragraphs then have no kinds. */
	readonly failed?: string;
}

/** What is known of a branch's paragraphs. */
export interface TagIndex {
	/** Each paragraph's kinds, by its hash, the latest record winning. */
	readonly kinds: ReadonlyMap<string, readonly SelectionKind[]>;
	/** The entries some record names, tagged or failed. */
	readonly entries: ReadonlySet<string>;
}

/** An index with nothing in it yet, to be filled by {@link indexTags}. */
export function emptyTagIndex(): {
	kinds: Map<string, readonly SelectionKind[]>;
	entries: Set<string>;
} {
	return { kinds: new Map(), entries: new Set() };
}

/** Add one record to an index. */
export function indexTags(
	index: ReturnType<typeof emptyTagIndex>,
	tags: SelectionTags,
): void {
	index.entries.add(tags.entryId);
	for (const unit of tags.units) index.kinds.set(unit.hash, unit.kinds);
}

/** Every tag recorded on a branch. */
export function readTags(branch: readonly SessionEntry[]): TagIndex {
	const index = emptyTagIndex();
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== SELECTION_TAGS_ENTRY)
			continue;
		const read = asTags(entry.data);
		if (read) indexTags(index, read);
	}
	return index;
}

/**
 * The messages still to tag: those after the last compaction with a
 * paragraph worth reading that nothing is known of. Anything before the
 * last compaction was either tagged while it was live or is left be,
 * so opening an old session does not tag its whole history. A message
 * a record names by id counts as known, which is how a failure recorded
 * before failures listed their paragraphs is still not asked again.
 */
export function untagged(
	branch: readonly SessionEntry[],
	tags: TagIndex,
): SessionEntry[] {
	let start = 0;
	branch.forEach((entry, at) => {
		if (entry.type === "compaction") start = at + 1;
	});
	return branch.slice(start).filter((entry) => {
		if (tags.entries.has(entry.id)) return false;
		return unitsOf(entry).some((unit) => !tags.kinds.has(unit.hash));
	});
}

/** Read one recorded entry's data as tags, or nothing when it will not read. */
export function asTags(data: unknown): SelectionTags | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const record = data as Record<string, unknown>;
	if (typeof record.entryId !== "string" || !Array.isArray(record.units))
		return undefined;
	const units: UnitTags[] = [];
	for (const unit of record.units) {
		if (typeof unit !== "object" || unit === null) continue;
		const { hash, kinds } = unit as Record<string, unknown>;
		if (typeof hash !== "string" || !Array.isArray(kinds)) continue;
		units.push({ hash, kinds: kinds.filter(isSelectionKind) });
	}
	return {
		entryId: record.entryId,
		units,
		...(typeof record.model === "string" ? { model: record.model } : {}),
		...(typeof record.failed === "string" ? { failed: record.failed } : {}),
	};
}

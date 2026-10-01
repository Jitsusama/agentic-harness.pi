/**
 * The tags the selection records on the session: for one message, the
 * kinds each of its paragraphs was found to be, with what finding them
 * cost.
 *
 * They are custom entries so they persist with the session and cost
 * nothing in the conversation: a custom entry is never sent to the
 * model. The usage is recorded on the entry because the ledger bills a
 * custom entry that carries its own usage as a side call.
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
	/** Every paragraph that was asked about, kinds or none. */
	readonly units: readonly UnitTags[];
	/** The model that answered. */
	readonly model?: string;
	readonly usage?: Usage;
	/** Why tagging failed, when it did; the message is then left untagged. */
	readonly failed?: string;
}

/** Every message's tags on a branch, by the message's entry id. */
export function readTags(
	branch: readonly SessionEntry[],
): Map<string, SelectionTags> {
	const tags = new Map<string, SelectionTags>();
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== SELECTION_TAGS_ENTRY)
			continue;
		const read = asTags(entry.data);
		if (read) tags.set(read.entryId, read);
	}
	return tags;
}

/**
 * The messages still to tag: those after the last compaction with a
 * paragraph worth reading and no tags recorded. Anything before the
 * last compaction was either tagged while it was live or is left be,
 * so opening an old session does not tag its whole history.
 */
export function untagged(
	branch: readonly SessionEntry[],
	tags: ReadonlyMap<string, SelectionTags>,
): SessionEntry[] {
	let start = 0;
	branch.forEach((entry, at) => {
		if (entry.type === "compaction") start = at + 1;
	});
	return branch
		.slice(start)
		.filter((entry) => !tags.has(entry.id) && unitsOf(entry).length > 0);
}

function asTags(data: unknown): SelectionTags | undefined {
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

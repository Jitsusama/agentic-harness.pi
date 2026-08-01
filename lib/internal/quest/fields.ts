/**
 * How to read and write each quest front-matter field the structural
 * journal records.
 *
 * This exists because the same knowledge used to live in three
 * switch statements: one to diff a write into journal changes, one to
 * check the on-disk value still matched before undoing, and one to
 * write the old value back. They agreed, but only by coincidence, and
 * a field added to one and missed in another failed silently in the
 * worst direction: the change was journalled and then skipped forever
 * at undo time, or reversed without ever being checked.
 *
 * With one table, a field is journalled exactly when it is
 * reversible, because both questions read the same entry.
 */

import type {
	QuestFrontMatter,
	QuestKind,
	QuestPriority,
	QuestStatus,
} from "../../quest/types.js";
import type { MutableField } from "./structural-journal.js";

/** Reading and writing one field, as strings, the way the journal holds them. */
export interface QuestFieldLens {
	/** The field's current value, or null where the field is unset. */
	read(fm: QuestFrontMatter): string | null;
	/** The front matter with the field set, or why the value is not allowed. */
	write(
		fm: QuestFrontMatter,
		value: string | null,
	): { ok: true; fm: QuestFrontMatter } | { ok: false; reason: string };
}

const STATUSES: QuestStatus[] = [
	"active",
	"paused",
	"blocked",
	"concluded",
	"retired",
];
const PRIORITIES: QuestPriority[] = [
	"driving",
	"active",
	"queued",
	"bench",
	"someday",
];
const KINDS: QuestKind[] = ["quest", "subquest", "sidequest"];

/**
 * A lens over a field holding one of a fixed set of words.
 *
 * The vocabulary is checked rather than cast. Undo used to cast a
 * journalled string straight to the field's type, which is fine while
 * every journal entry was written by the current build and unsafe the
 * moment one was not: a word the vocabulary has since lost would be
 * written back unexamined.
 */
function wordFrom<K extends "status" | "priority" | "kind">(
	field: K,
	vocabulary: QuestFrontMatter[K][],
): QuestFieldLens {
	return {
		read: (fm) => fm[field],
		write: (fm, value) => {
			const allowed = vocabulary as string[];
			if (value === null || !allowed.includes(value)) {
				return {
					ok: false,
					reason: `Cannot set ${field} to ${value ?? "nothing"}: it is not one of ${allowed.join(", ")}.`,
				};
			}
			return { ok: true, fm: { ...fm, [field]: value } };
		},
	};
}

const LENSES: Partial<Record<MutableField, QuestFieldLens>> = {
	// Nullable: a quest at top level has no parent, and undoing a
	// reparent to top level means writing that null back deliberately.
	parent: {
		read: (fm) => fm.parent ?? null,
		write: (fm, value) => ({ ok: true, fm: { ...fm, parent: value } }),
	},
	status: wordFrom("status", STATUSES),
	priority: wordFrom("priority", PRIORITIES),
	kind: wordFrom("kind", KINDS),
	rank: {
		read: (fm) => String(fm.rank),
		write: (fm, value) => {
			const rank = Number(value);
			if (value === null || value.trim() === "" || !Number.isFinite(rank)) {
				return {
					ok: false,
					reason: `Cannot set rank to ${value ?? "nothing"}: it is not a number.`,
				};
			}
			return { ok: true, fm: { ...fm, rank } };
		},
	},
	// No entry for `stage`. It is journallable, but it lives on a
	// document rather than on the quest README, so there is nothing here
	// that could read or write it. Undo finds no lens and skips the
	// change, which is the honest reason rather than a sentinel value
	// contrived never to match.
};

/** How to read and write `field`, or undefined if it is not on a quest README. */
export function lensForField(field: MutableField): QuestFieldLens | undefined {
	return LENSES[field];
}

/**
 * The fields the journal tracks and undo can reverse. One list,
 * derived from the table, so the two cannot drift apart.
 */
export function reversibleFields(): MutableField[] {
	return Object.keys(LENSES) as MutableField[];
}

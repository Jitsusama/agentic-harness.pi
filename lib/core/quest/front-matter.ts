/**
 * Writing the fields of a quest's front matter: by folder for any
 * quest, loaded or not, or on the loaded one, and its aliases a batch
 * at a time. Every write goes through the validated mutation core,
 * which locks, stamps `updated` and parses the result back.
 */

import { appendJourneyByPath } from "../../internal/quest/documents/append-journey.ts";
import type { QuestFieldLens } from "../../internal/quest/fields/fields.ts";
import { mutateQuestFrontMatter } from "../../internal/quest/fields/mutate.ts";
import type {
	QuestAlias,
	QuestFrontMatter,
	QuestStatus,
} from "../../quest/index.ts";
import type { QuestState } from "./state.ts";

/**
 * Rewrite the front matter of the quest in `questDir` through the
 * mutation core, answering the written front matter or why it could
 * not be written. A mutation answering undefined writes nothing.
 */
export function writeQuestFrontMatter(
	questDir: string,
	mutate: (fm: QuestFrontMatter) => QuestFrontMatter | undefined,
): { ok: true; fm: QuestFrontMatter } | { ok: false; guidance: string } {
	const result = mutateQuestFrontMatter(questDir, mutate);
	if (!result.ok) return result;
	return { ok: true, fm: result.fm };
}

/**
 * Set any journalled field by directory, through the lens that knows
 * how to write it.
 *
 * Undo used to reach for one exported setter per field and cast the
 * journalled string to that field's type on the way in. The lens
 * checks the value against the field's vocabulary instead, so a
 * journal entry carrying a word the vocabulary has since lost is
 * refused with a reason rather than written back unexamined.
 */
export function setQuestFieldByDir(
	questDir: string,
	lens: QuestFieldLens,
	value: string | null,
): { ok: true } | { ok: false; guidance: string } {
	let refusal: string | undefined;
	const result = writeQuestFrontMatter(questDir, (fm) => {
		const written = lens.write(fm, value);
		if (written.ok) return written.fm;
		refusal = written.reason;
		return undefined;
	});
	if (refusal) return { ok: false, guidance: refusal };
	if (!result.ok) return result;
	return { ok: true };
}

/**
 * Set a quest's parent by directory, stamping `updated` and
 * appending a Journey entry. Used by the reparent verb, which
 * may move quests other than the loaded one.
 */
export function setQuestParent(
	questDir: string,
	newParent: string | null,
): { ok: true } | { ok: false; guidance: string } {
	const result = writeQuestFrontMatter(questDir, (fm) => ({
		...fm,
		parent: newParent,
	}));
	if (!result.ok) return result;
	appendJourneyByPath(questDir, `Reparented to ${newParent ?? "top level"}.`);
	return { ok: true };
}

/** Set a quest's status by directory, stamping `updated`. */
export function setQuestStatusByDir(
	questDir: string,
	status: QuestFrontMatter["status"],
): { ok: true } | { ok: false; guidance: string } {
	const result = writeQuestFrontMatter(questDir, (fm) => ({ ...fm, status }));
	if (!result.ok) return result;
	return { ok: true };
}

/**
 * Set a quest's priority by directory. Used by the priority verbs,
 * the bulk seal cascade, and undo when it reverses a journalled
 * priority change.
 */
export function setQuestPriorityByDir(
	questDir: string,
	priority: QuestFrontMatter["priority"],
): { ok: true } | { ok: false; guidance: string } {
	const result = writeQuestFrontMatter(questDir, (fm) => ({ ...fm, priority }));
	if (!result.ok) return result;
	return { ok: true };
}

/**
 * Add one or more aliases to the quest in `questDir` in a single front-matter
 * write, so a list either lands whole or not at all and no partial
 * state survives a failure. Aliases already present, and duplicates
 * within the batch, are reported as already and added only once.
 */
export function addAliasesToQuest(
	questDir: string,
	aliases: QuestAlias[],
):
	| { ok: true; added: QuestAlias[]; already: QuestAlias[] }
	| { ok: false; guidance: string } {
	let added: QuestAlias[] = [];
	let already: QuestAlias[] = [];
	const result = writeQuestFrontMatter(questDir, (fm) => {
		// Reset on every invocation so a retried write does not
		// accumulate duplicate report entries.
		added = [];
		already = [];
		const next = [...fm.aliases];
		for (const alias of aliases) {
			const present = next.some(
				(a) => a.type === alias.type && a.value === alias.value,
			);
			if (present) {
				already.push(alias);
				continue;
			}
			added.push(alias);
			next.push(alias);
		}
		return { ...fm, aliases: next };
	});
	if (!result.ok) return result;
	return { ok: true, added, already };
}

/**
 * Remove one or more aliases from the quest in `questDir` in a single
 * write, the batch counterpart to addAliasesToQuest. Reports which were
 * removed and which were absent, so the verb can signal a partial or
 * whole no-op the same way the add path does.
 */
export function removeAliasesFromQuest(
	questDir: string,
	aliases: QuestAlias[],
):
	| { ok: true; removed: QuestAlias[]; absent: QuestAlias[] }
	| { ok: false; guidance: string } {
	let removed: QuestAlias[] = [];
	let absent: QuestAlias[] = [];
	const result = writeQuestFrontMatter(questDir, (fm) => {
		removed = [];
		absent = [];
		const drop = (a: QuestAlias) =>
			aliases.some((t) => t.type === a.type && t.value === a.value);
		for (const target of aliases) {
			if (
				fm.aliases.some(
					(a) => a.type === target.type && a.value === target.value,
				)
			) {
				removed.push(target);
			} else {
				absent.push(target);
			}
		}
		if (removed.length === 0) return undefined;
		return { ...fm, aliases: fm.aliases.filter((a) => !drop(a)) };
	});
	if (!result.ok) return result;
	return { ok: true, removed, absent };
}

/**
 * Change the loaded quest's kind. A subquest needs a parent to rank
 * within, so refuse the move to subquest when the quest has none.
 * Returns whether the kind actually changed.
 */
export function setLoadedKind(
	state: QuestState,
	kind: QuestFrontMatter["kind"],
): { ok: true; changed: boolean } | { ok: false; guidance: string } {
	if (!state.questDir) return { ok: false, guidance: "Load a quest first." };
	let changed = false;
	let refusal: string | undefined;
	const result = writeQuestFrontMatter(state.questDir, (fm) => {
		if (fm.kind === kind) return undefined;
		if (kind === "subquest" && (fm.parent ?? null) === null) {
			refusal =
				"A subquest needs a parent to rank within; reparent it under a quest first.";
			return undefined;
		}
		changed = true;
		return { ...fm, kind };
	});
	if (refusal) return { ok: false, guidance: refusal };
	if (!result.ok) return result;
	return { ok: true, changed };
}

/** Set the loaded quest's coarse status enum. */
export function setLoadedStatus(
	state: QuestState,
	status: QuestStatus,
): { ok: true; changed: boolean } | { ok: false; guidance: string } {
	if (!state.questDir) return { ok: false, guidance: "Load a quest first." };
	let changed = false;
	const result = writeQuestFrontMatter(state.questDir, (fm) => {
		if (fm.status === status) return undefined;
		changed = true;
		return { ...fm, status };
	});
	if (!result.ok) return result;
	if (changed) {
		state.questStatus = status;
	}
	return { ok: true, changed };
}

/**
 * Alias verbs: alias-add and alias-remove. Parses both the
 * `type:value` literal form and recognised URL shapes
 * through the refs registry.
 */

import {
	buildAliasIndex,
	lookupAliasDetail,
} from "../../../internal/quest/creation/alias-index.ts";
import type { QuestIndex } from "../../../internal/quest/discovery/discovery.ts";
import { discoverQuests } from "../../../internal/quest/discovery/discovery.ts";
import { appendHarnessLog } from "../../../internal/quest/documents/harness-log.ts";
import type { QuestAlias } from "../../../quest/index.ts";
import { parseRef } from "../../../refs/index.ts";
import { addAliasesToQuest, removeAliasesFromQuest } from "../lifecycle.ts";
import type { QuestState } from "../state.ts";
import {
	commaList,
	ok,
	type QuestResult,
	type QuestToolParams,
	refuse,
} from "./shared.ts";

/**
 * Parse the user's alias input. Prefers the literal
 * `type:value` form when the prefix looks like a registered
 * ref type. Falls back to URL detection via the refs
 * registry.
 */
function parseAliasInput(raw: string): QuestAlias | undefined {
	const trimmed = raw.trim();
	if (!trimmed) return undefined;
	const literal = /^([a-z][a-z0-9-]*):(.+)$/i.exec(trimmed);
	if (literal) {
		const type = literal[1]?.trim();
		const value = literal[2]?.trim();
		if (type && value && !/^https?$/i.test(type)) {
			return { type, value };
		}
	}
	const ref = parseRef(trimmed);
	if (ref) return { type: ref.type, value: ref.value };
	return undefined;
}

/**
 * The aliases `params.ref` or `params.url` gives, or why they cannot
 * be taken: the first entry that is not an alias, or `none` when there
 * are no entries at all. A comma separates entries, since a
 * `type:value` literal and a URL both have no bare comma, so one call
 * can add or remove several.
 */
function aliasesGiven(
	params: QuestToolParams,
	none: string,
): QuestAlias[] | string {
	const aliases: QuestAlias[] = [];
	for (const token of commaList(params.ref ?? params.url)) {
		const alias = parseAliasInput(token);
		if (!alias) {
			return `Could not parse "${token}" as an alias. Use the \`type:value\` form (e.g. \`github-pr:shop/world#47281\`) or a recognised URL; separate several with commas.`;
		}
		aliases.push(alias);
	}
	return aliases.length > 0 ? aliases : none;
}

/** How an alias is named back to the person. */
function aliasLabels(aliases: readonly QuestAlias[]): string {
	return aliases.map((a) => `${a.type}:${a.value}`).join(", ");
}

/** A quest an alias verb acts on: its id and its folder. */
interface AliasTarget {
	id: string;
	dir: string;
}

/**
 * The quest `params.id` names, or the loaded one when it names none,
 * or why there is none: an id no quest has is refused rather than
 * taken for the loaded quest, which once took an alias meant for
 * another and reported it added.
 */
function aliasTarget(
	state: QuestState,
	params: QuestToolParams,
	index: QuestIndex,
): AliasTarget | string {
	if (params.id) {
		const entry = index.quests.get(params.id);
		if (!entry) {
			return `No quest has the id ${params.id}. Name a quest's id in \`id\`, or leave it out for the loaded quest.`;
		}
		return { id: params.id, dir: entry.dir };
	}
	if (!state.questId || !state.questDir) {
		return "Load a quest first, or name one in `id`.";
	}
	return { id: state.questId, dir: state.questDir };
}

/** Add the aliases `params.ref` or `params.url` gives to the quest `params.id` names, or the loaded one. */
export function aliasAdd(
	state: QuestState,
	params: QuestToolParams,
): QuestResult {
	const { index } = discoverQuests(state.questsRoot);
	const target = aliasTarget(state, params, index);
	if (typeof target === "string") return refuse(target);
	const aliases = aliasesGiven(
		params,
		"Pass the alias in `ref` (e.g. `github-pr:shop/world#47281`) or in `url` (a recognised URL). Separate several with commas.",
	);
	if (typeof aliases === "string") return refuse(aliases);
	// Refuse a ref that already lives on another quest: routing the
	// same alias to two quests would mis-attribute the linked work.
	const aliasIdx = buildAliasIndex(index);
	for (const alias of aliases) {
		const lookup = lookupAliasDetail(aliasIdx, alias);
		if (lookup.kind === "collision") {
			return refuse(
				`Alias ${alias.type}:${alias.value} is already on multiple quests (${lookup.questIds.join(", ")}). Resolve the duplicate before adding it again.`,
			);
		}
		if (lookup.kind === "hit" && lookup.questId !== target.id) {
			return refuse(
				`Alias ${alias.type}:${alias.value} is already on quest ${lookup.questId}. Name that quest in \`id\`, or remove it there first.`,
			);
		}
	}
	// One write lands the whole list, so a mid-list failure cannot
	// leave a partial set behind.
	const result = addAliasesToQuest(target.dir, aliases);
	if (!result.ok) return refuse(result.guidance);
	const { added, already } = result;
	for (const alias of added) {
		appendHarnessLog(target.dir, `Linked ${alias.type}:${alias.value}.`);
	}
	if (added.length === 0) {
		return ok(
			`Alias ${aliasLabels(already)} was already present on ${target.id}.`,
			{
				aliases: already,
				added: false,
			},
		);
	}
	let message = `Added alias ${aliasLabels(added)} to ${target.id}.`;
	if (already.length > 0) {
		message += ` ${aliasLabels(already)} already present.`;
	}
	return ok(message, { aliases: added, added: true });
}

/** Remove the aliases `params.ref` or `params.url` gives from the quest `params.id` names, or the loaded one. */
export function aliasRemove(
	state: QuestState,
	params: QuestToolParams,
): QuestResult {
	const target = aliasTarget(
		state,
		params,
		discoverQuests(state.questsRoot).index,
	);
	if (typeof target === "string") return refuse(target);
	const aliases = aliasesGiven(
		params,
		"Pass the alias in `ref` (e.g. `github-pr:shop/world#47281`) or in `url`. Separate several with commas.",
	);
	if (typeof aliases === "string") return refuse(aliases);
	const result = removeAliasesFromQuest(target.dir, aliases);
	if (!result.ok) return refuse(result.guidance);
	const { removed, absent } = result;
	// A no-op is reported as success, matching alias-add: "nothing to
	// remove" is the same outcome as "already present", not a refusal.
	if (removed.length === 0) {
		return ok(
			`Alias ${aliasLabels(absent)} was not on this quest, ${target.id}.`,
			{
				aliases: absent,
				removed: false,
			},
		);
	}
	let message = `Removed alias ${aliasLabels(removed)} from ${target.id}.`;
	if (absent.length > 0) {
		message += ` ${aliasLabels(absent)} was not on this quest.`;
	}
	return ok(message, { aliases: removed, removed: true });
}

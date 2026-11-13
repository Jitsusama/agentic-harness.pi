/**
 * Alias verbs: alias-add and alias-remove. Parses both the
 * `type:value` literal form and recognised URL shapes
 * through the refs registry.
 */

import {
	buildAliasIndex,
	lookupAliasDetail,
} from "../../../internal/quest/alias-index.ts";
import type { QuestIndex } from "../../../internal/quest/discovery.ts";
import { discoverQuests } from "../../../internal/quest/discovery.ts";
import { appendHarnessLog } from "../../../internal/quest/harness-log.ts";
import type { QuestAlias } from "../../../quest/index.ts";
import { parseRef } from "../../../refs/index.ts";
import { addAliasesToQuest, removeAliasesFromQuest } from "../lifecycle.ts";
import type { QuestState } from "../state.ts";
import {
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
		const type = literal[1].trim();
		const value = literal[2].trim();
		if (type && value && !/^https?$/i.test(type)) {
			return { type, value };
		}
	}
	const ref = parseRef(trimmed);
	if (ref) return { type: ref.type, value: ref.value };
	return undefined;
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
	const input = params.ref ?? params.url ?? "";
	// A comma separates entries: a type:value literal and a URL both
	// have no bare comma, so splitting first lets one call add several.
	const tokens = input
		.split(",")
		.map((t) => t.trim())
		.filter((t) => t.length > 0);
	const aliases: QuestAlias[] = [];
	for (const token of tokens) {
		const alias = parseAliasInput(token);
		if (!alias) {
			return refuse(
				`Could not parse "${token}" as an alias. Use the \`type:value\` form (e.g. \`github-pr:shop/world#47281\`) or a recognised URL; separate several with commas.`,
			);
		}
		aliases.push(alias);
	}
	if (aliases.length === 0) {
		return refuse(
			"Pass the alias in `ref` (e.g. `github-pr:shop/world#47281`) or in `url` (a recognised URL). Separate several with commas.",
		);
	}
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
	const label = (a: QuestAlias) => `${a.type}:${a.value}`;
	if (added.length === 0) {
		return ok(
			`Alias ${already.map(label).join(", ")} was already present on ${target.id}.`,
			{
				aliases: already,
				added: false,
			},
		);
	}
	let message = `Added alias ${added.map(label).join(", ")} to ${target.id}.`;
	if (already.length > 0) {
		message += ` ${already.map(label).join(", ")} already present.`;
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
	const input = params.ref ?? params.url ?? "";
	// Accept a comma batch, matching alias-add, so several aliases can be
	// scrubbed in one call rather than one at a time.
	const tokens = input
		.split(",")
		.map((t) => t.trim())
		.filter((t) => t.length > 0);
	const aliases: QuestAlias[] = [];
	for (const token of tokens) {
		const alias = parseAliasInput(token);
		if (!alias) {
			return refuse(
				`Could not parse "${token}" as an alias. Use the \`type:value\` form (e.g. \`github-pr:shop/world#47281\`) or a recognised URL; separate several with commas.`,
			);
		}
		aliases.push(alias);
	}
	if (aliases.length === 0) {
		return refuse(
			"Pass the alias in `ref` (e.g. `github-pr:shop/world#47281`) or in `url`. Separate several with commas.",
		);
	}
	const result = removeAliasesFromQuest(target.dir, aliases);
	if (!result.ok) return refuse(result.guidance);
	const { removed, absent } = result;
	const label = (a: QuestAlias) => `${a.type}:${a.value}`;
	// A no-op is reported as success, matching alias-add: "nothing to
	// remove" is the same outcome as "already present", not a refusal.
	if (removed.length === 0) {
		return ok(
			`Alias ${absent.map(label).join(", ")} was not on this quest, ${target.id}.`,
			{
				aliases: absent,
				removed: false,
			},
		);
	}
	let message = `Removed alias ${removed.map(label).join(", ")} from ${target.id}.`;
	if (absent.length > 0) {
		message += ` ${absent.map(label).join(", ")} was not on this quest.`;
	}
	return ok(message, { aliases: removed, removed: true });
}

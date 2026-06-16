/**
 * Alias verbs: alias-add and alias-remove. Parses both the
 * `type:value` literal form and recognised URL shapes
 * through the refs registry.
 */

import type { QuestAlias } from "../../../lib/quest/index.js";
import { parseRef } from "../../../lib/refs/index.js";
import {
	addAliasesToLoaded,
	appendJourneyEntry,
	removeAliasFromLoaded,
} from "../lifecycle.js";
import type { QuestState } from "../state.js";
import {
	ok,
	type QuestResult,
	type QuestToolParams,
	refuse,
} from "./shared.js";

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

export function aliasAdd(
	state: QuestState,
	params: QuestToolParams,
): QuestResult {
	if (!state.questId) return refuse("Load a quest first.");
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
	// One write lands the whole list, so a mid-list failure cannot
	// leave a partial set behind.
	const result = addAliasesToLoaded(state, aliases);
	if (!result.ok) return refuse(result.guidance);
	const { added, already } = result;
	for (const alias of added) {
		appendJourneyEntry(state, `Linked ${alias.type}:${alias.value}.`);
	}
	const label = (a: QuestAlias) => `${a.type}:${a.value}`;
	if (added.length === 0) {
		return ok(`Alias ${already.map(label).join(", ")} was already present.`, {
			aliases: already,
			added: false,
		});
	}
	let message = `Added alias ${added.map(label).join(", ")}.`;
	if (already.length > 0) {
		message += ` ${already.map(label).join(", ")} already present.`;
	}
	return ok(message, { aliases: added, added: true });
}

export function aliasRemove(
	state: QuestState,
	params: QuestToolParams,
): QuestResult {
	if (!state.questId) return refuse("Load a quest first.");
	const input = params.ref ?? params.url ?? "";
	const alias = parseAliasInput(input);
	if (!alias) {
		return refuse(
			"Pass the alias in `ref` (e.g. `github-pr:shop/world#47281`) or in `url`.",
		);
	}
	const result = removeAliasFromLoaded(state, alias);
	if (!result.ok) return refuse(result.guidance);
	if (!result.removed) {
		return refuse(`Alias ${alias.type}:${alias.value} is not on this quest.`);
	}
	return ok(`Removed alias ${alias.type}:${alias.value}.`, { alias });
}

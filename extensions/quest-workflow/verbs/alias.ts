/**
 * Alias verbs: alias-add and alias-remove. Parses both the
 * `type:value` literal form and recognised URL shapes
 * through the refs registry.
 */

import type { QuestAlias } from "../../../lib/quest/index.js";
import { parseRef } from "../../../lib/refs/index.js";
import {
	addAliasToLoaded,
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
	const alias = parseAliasInput(input);
	if (!alias) {
		return refuse(
			"Pass the alias in `ref` (e.g. `github-pr:shop/world#47281`) or in `url` (a recognised URL).",
		);
	}
	const result = addAliasToLoaded(state, alias);
	if (!result.ok) return refuse(result.guidance);
	if (!result.added) {
		return ok(`Alias ${alias.type}:${alias.value} was already present.`, {
			alias,
			added: false,
		});
	}
	appendJourneyEntry(state, `Linked ${alias.type}:${alias.value}.`);
	return ok(`Added alias ${alias.type}:${alias.value}.`, {
		alias,
		added: true,
	});
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

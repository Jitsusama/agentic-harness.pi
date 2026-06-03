/**
 * Reverse index from alias `type:value` keys to quest ids.
 *
 * Built once from a `QuestIndex` (the discovery walk's
 * output). The `quest create` action uses this to detect
 * "this URL is already attached to an existing quest" and
 * propose loading instead of creating a duplicate.
 */

import type { QuestAlias } from "../../quest/types.js";
import type { QuestIndex } from "./discovery.js";

/** Format a `{type, value}` alias as a flat lookup key. */
export function aliasKey(alias: QuestAlias): string {
	return `${alias.type}:${alias.value}`;
}

export interface AliasIndex {
	/** Map from `type:value` to the quest id it appears in. */
	byKey: Map<string, string>;
}

/** Build a reverse index across every quest in the index. */
export function buildAliasIndex(index: QuestIndex): AliasIndex {
	const byKey = new Map<string, string>();
	for (const entry of index.quests.values()) {
		for (const alias of entry.doc.frontMatter.aliases) {
			const key = aliasKey(alias);
			// First-write wins; duplicates across quests are a
			// data problem the discovery walk should surface
			// separately. We just don't overwrite.
			if (!byKey.has(key)) byKey.set(key, entry.doc.frontMatter.id);
		}
	}
	return { byKey };
}

/** Find the quest id holding this alias, if any. */
export function lookupAlias(
	index: AliasIndex,
	alias: QuestAlias,
): string | undefined {
	return index.byKey.get(aliasKey(alias));
}

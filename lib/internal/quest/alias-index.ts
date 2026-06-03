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
	/**
	 * Map from `type:value` to the quest id it appears in.
	 * When the same key appears on more than one quest, the
	 * key is also in `collisions` and `byKey` holds the
	 * lexicographically-first id (a stable choice the
	 * consumer can name in the error message).
	 */
	byKey: Map<string, string>;
	/**
	 * Every alias key that appears on more than one quest,
	 * with the full set of quest ids that share it. Consumers
	 * should refuse the operation when the alias they care
	 * about is in this map, since silently routing to the
	 * first-write-wins quest would mis-attribute work.
	 */
	collisions: Map<string, string[]>;
}

/** Build a reverse index across every quest in the index. */
export function buildAliasIndex(index: QuestIndex): AliasIndex {
	const occurrences = new Map<string, string[]>();
	for (const entry of index.quests.values()) {
		for (const alias of entry.doc.frontMatter.aliases) {
			const key = aliasKey(alias);
			const list = occurrences.get(key) ?? [];
			if (!list.includes(entry.doc.frontMatter.id)) {
				list.push(entry.doc.frontMatter.id);
			}
			occurrences.set(key, list);
		}
	}
	const byKey = new Map<string, string>();
	const collisions = new Map<string, string[]>();
	for (const [key, ids] of occurrences) {
		const sorted = [...ids].sort();
		byKey.set(key, sorted[0]);
		if (sorted.length > 1) collisions.set(key, sorted);
	}
	return { byKey, collisions };
}

/**
 * Find the quest id holding this alias, if any.
 *
 * Returns `undefined` when the alias is unknown OR when it
 * is shared across multiple quests. Use `lookupAliasDetail`
 * (below) when you need to distinguish those cases and
 * surface the collision to the user.
 */
export function lookupAlias(
	index: AliasIndex,
	alias: QuestAlias,
): string | undefined {
	const key = aliasKey(alias);
	if (index.collisions.has(key)) return undefined;
	return index.byKey.get(key);
}

export type AliasLookup =
	| { kind: "miss" }
	| { kind: "hit"; questId: string }
	| { kind: "collision"; questIds: string[] };

/**
 * Look up an alias and surface duplicates explicitly so the
 * caller can refuse with a clear "alias X points at quests
 * A and B" message rather than silently routing to one.
 */
export function lookupAliasDetail(
	index: AliasIndex,
	alias: QuestAlias,
): AliasLookup {
	const key = aliasKey(alias);
	const collisionIds = index.collisions.get(key);
	if (collisionIds) return { kind: "collision", questIds: collisionIds };
	const questId = index.byKey.get(key);
	if (questId) return { kind: "hit", questId };
	return { kind: "miss" };
}

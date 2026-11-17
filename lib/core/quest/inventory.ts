/**
 * What the quests root holds, read across every quest: one quest by
 * id, all of them, and every working tree they record, so the trees
 * the harness made can be seen and reaped in one place.
 */

import { existsSync, mkdirSync } from "node:fs";
import {
	discoverQuests,
	type QuestEntry,
} from "../../internal/quest/discovery/discovery.ts";
import {
	type TreePlace,
	treePlace,
} from "../../internal/quest/workspace/tree-place.ts";
import type { QuestState } from "./state.ts";

/** Find a quest entry by id across the quests root. */
export function findQuestEntry(
	state: QuestState,
	id: string,
): QuestEntry | undefined {
	const { index } = discoverQuests(state.questsRoot);
	return index.quests.get(id);
}

/** One working tree in the cross-quest inventory. */
export interface WorktreeInventoryEntry {
	path: string;
	branch?: string;
	questId: string;
	questTitle: string | null;
	/** Whether the tree's directory still exists on disk. */
	exists: boolean;
	/** Whether it is this machine's, another's, or can't be told. */
	place: TreePlace;
}

/**
 * Inventory every working tree recorded across all quests,
 * attributing each to its owning quest. This is what lets the
 * harness-created trees be seen and reaped in one place instead
 * of being a mystery pile of directories.
 */
export function inventoryWorktrees(
	state: QuestState,
): WorktreeInventoryEntry[] {
	const { index } = discoverQuests(state.questsRoot);
	const entries: WorktreeInventoryEntry[] = [];
	for (const quest of index.quests.values()) {
		const fm = quest.doc.frontMatter;
		for (const tree of fm.trees ?? []) {
			const entry: WorktreeInventoryEntry = {
				path: tree.path,
				questId: fm.id,
				questTitle: quest.doc.title ?? null,
				exists: existsSync(tree.path),
				place: treePlace(tree),
			};
			if (tree.branch) entry.branch = tree.branch;
			entries.push(entry);
		}
	}
	return entries.sort((a, b) => a.path.localeCompare(b.path));
}

/** Discover quests for /quest-list etc. */
export function listAllQuests(state: QuestState): QuestEntry[] {
	const { index } = discoverQuests(state.questsRoot);
	return [...index.quests.values()];
}

/** Ensure the quests root exists on disk. */
export function ensureQuestsRoot(state: QuestState): void {
	if (!existsSync(state.questsRoot)) {
		mkdirSync(state.questsRoot, { recursive: true });
	}
}

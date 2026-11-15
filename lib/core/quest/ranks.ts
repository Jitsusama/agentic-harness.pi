/**
 * A quest's place among its siblings, the open quests sharing its
 * parent and priority: reordering them and writing each changed rank
 * back, and setting one quest's rank for undo.
 */

import {
	discoverQuests,
	type QuestEntry,
} from "../../internal/quest/discovery.ts";
import { mutateQuestFrontMatter } from "../../internal/quest/mutate.ts";
import {
	diffRanks,
	type RankEntry,
	after as rankAfter,
	before as rankBefore,
	bottom as rankBottom,
	bump as rankBump,
	renumber as rankRenumber,
	sink as rankSink,
	top as rankTop,
} from "../../internal/quest/ranking.ts";
import { isSealedStatus } from "../../internal/quest/status.ts";
import { writeQuestFrontMatter } from "./front-matter.ts";
import type { QuestState } from "./state.ts";

/** Where a reorder moves a quest among its siblings. */
export type RankAction =
	| { kind: "top" }
	| { kind: "bottom" }
	| { kind: "bump" }
	| { kind: "sink" }
	| { kind: "before"; target: string }
	| { kind: "after"; target: string }
	| { kind: "renumber" };

/** The sibling set a reorder read, and each rank it changed. */
export interface ReorderResult {
	siblings: QuestEntry[];
	changes: { id: string; from: number; to: number }[];
}

/**
 * Reorder the sibling set the given quest belongs to.
 * Siblings share both `parent` and `priority`. Writes the
 * updated rank back to every quest whose rank changed.
 */
export function reorderSiblings(
	state: QuestState,
	questId: string,
	action: RankAction,
): { ok: true; result: ReorderResult } | { ok: false; guidance: string } {
	const { index } = discoverQuests(state.questsRoot);
	const pivot = index.quests.get(questId);
	if (!pivot) {
		return {
			ok: false,
			guidance: `No quest with id "${questId}" under ${state.questsRoot}.`,
		};
	}
	if (isSealedStatus(pivot.doc.frontMatter.status)) {
		return {
			ok: false,
			guidance: `Quest "${questId}" is ${pivot.doc.frontMatter.status}; reopen it before reordering.`,
		};
	}
	const siblings: QuestEntry[] = [];
	for (const entry of index.quests.values()) {
		if (
			entry.doc.frontMatter.parent === pivot.doc.frontMatter.parent &&
			entry.doc.frontMatter.priority === pivot.doc.frontMatter.priority &&
			!isSealedStatus(entry.doc.frontMatter.status)
		) {
			siblings.push(entry);
		}
	}
	const before: RankEntry[] = siblings.map((e) => ({
		id: e.doc.frontMatter.id,
		rank: e.doc.frontMatter.rank,
	}));
	let after: RankEntry[];
	switch (action.kind) {
		case "top":
			after = rankTop(before, questId);
			break;
		case "bottom":
			after = rankBottom(before, questId);
			break;
		case "bump":
			after = rankBump(before, questId);
			break;
		case "sink":
			after = rankSink(before, questId);
			break;
		case "before":
			after = rankBefore(before, questId, action.target);
			break;
		case "after":
			after = rankAfter(before, questId, action.target);
			break;
		case "renumber":
			after = rankRenumber(before);
			break;
	}
	const changes = diffRanks(before, after);
	const rankById = new Map(after.map((e) => [e.id, e.rank]));
	for (const entry of siblings) {
		const newRank = rankById.get(entry.doc.frontMatter.id);
		if (newRank === undefined) continue;
		if (newRank === entry.doc.frontMatter.rank) continue;
		writeQuestRank(entry.dir, newRank);
	}
	return { ok: true, result: { siblings, changes } };
}

function writeQuestRank(questDir: string, rank: number): void {
	// Routed through the validated mutation core so a rank write is
	// validated and stamped the same way every other field write is.
	mutateQuestFrontMatter(questDir, (fm) => ({ ...fm, rank }));
}

/**
 * Set a quest's rank by directory. The by-dir counterpart to the
 * internal `writeQuestRank`, exported so undo can reverse a journalled
 * rank change (a reparent re-ranks into its new sibling set).
 */
export function setQuestRankByDir(
	questDir: string,
	rank: number,
): { ok: true } | { ok: false; guidance: string } {
	const result = writeQuestFrontMatter(questDir, (fm) => ({ ...fm, rank }));
	if (!result.ok) return result;
	return { ok: true };
}

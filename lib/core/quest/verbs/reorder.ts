/**
 * Rank-and-priority verbs: top, bottom, bump, sink,
 * before, after, renumber (sibling rank within a priority
 * bucket), plus promote / demote / drive / park / defer
 * (cross-bucket priority moves).
 */

import { appendJourneyByPath } from "../../../internal/quest/append-journey.ts";
import {
	discoverQuests,
	siblingRanks,
} from "../../../internal/quest/discovery.ts";
import { nextRank } from "../../../internal/quest/ranking.ts";
import { isSealedStatus } from "../../../internal/quest/status.ts";
import { recordStructuralOp } from "../../../internal/quest/structural-journal.ts";
import type { QuestPriority } from "../../../quest/index.ts";
import { count } from "../../../ui/count.ts";
import {
	type RankAction,
	reorderSiblings,
	setQuestPriorityByDir,
	setQuestRankByDir,
} from "../lifecycle.ts";
import type { QuestState } from "../state.ts";
import {
	ok,
	type QuestResult,
	type QuestToolParams,
	refuse,
} from "./shared.ts";

/** Reorder the loaded quest within its sibling set. */
export function reorder(
	state: QuestState,
	params: QuestToolParams,
): QuestResult {
	const questId = params.id ?? state.questId;
	if (!questId) {
		return refuse("Load a quest first or pass the quest id in `id`.");
	}
	let action: RankAction;
	switch (params.action) {
		case "top":
			action = { kind: "top" };
			break;
		case "bottom":
			action = { kind: "bottom" };
			break;
		case "bump":
			action = { kind: "bump" };
			break;
		case "sink":
			action = { kind: "sink" };
			break;
		case "renumber":
			action = { kind: "renumber" };
			break;
		case "before":
		case "after":
			if (!params.target) {
				return refuse(
					`\`${params.action}\` needs a \`target\` quest id to position against.`,
				);
			}
			action = { kind: params.action, target: params.target };
			break;
		default:
			return refuse(`Unknown reorder action ${params.action}.`);
	}
	const result = reorderSiblings(state, questId, action);
	if (!result.ok) return refuse(result.guidance);
	return ok(
		`Reordered ${count(result.result.changes.length, "quest")} in the sibling set.`,
		{ changes: result.result.changes },
	);
}

/** The priority buckets, from the most pressing to the least. */
const LADDER: readonly QuestPriority[] = [
	"driving",
	"active",
	"queued",
	"bench",
	"someday",
];

/**
 * Move the quest `params.id` names, or the loaded one, to the bucket
 * `target` picks from where it is: at the end of that bucket, written
 * in its Journey, and recorded so `undo` puts priority and rank back.
 * An id that names no quest is refused, never read as the loaded one.
 */
function movePriority(
	state: QuestState,
	op: string,
	params: QuestToolParams | undefined,
	target: (from: QuestPriority) => QuestPriority,
): QuestResult {
	const questId = params?.id ?? state.questId;
	if (!questId) {
		return refuse("Load a quest first or pass the quest id in `id`.");
	}
	const { index } = discoverQuests(state.questsRoot);
	const entry = index.quests.get(questId);
	if (!entry) {
		return refuse(`No quest with id "${questId}" under ${state.questsRoot}.`);
	}
	const fm = entry.doc.frontMatter;
	if (isSealedStatus(fm.status)) {
		return refuse(
			`Quest "${questId}" is ${fm.status}; reopen it before moving its priority.`,
		);
	}
	const from = fm.priority;
	const to = target(from);
	if (to === from) {
		return ok(`Quest ${questId} is already ${to}.`, { from, to });
	}
	// The end of the destination bucket, rather than colliding at rank 1.
	const rank = nextRank(siblingRanks(index, fm.parent ?? null, to, questId));
	const moved = setQuestPriorityByDir(entry.dir, to);
	if (!moved.ok) return refuse(moved.guidance);
	const ranked = setQuestRankByDir(entry.dir, rank);
	const changes = [
		{ id: questId, field: "priority" as const, old: from, new: to },
		...(ranked.ok
			? [
					{
						id: questId,
						field: "rank" as const,
						old: String(fm.rank),
						new: String(rank),
					},
				]
			: []),
	];
	recordStructuralOp(state.questsRoot, op, changes);
	if (questId === state.questId) state.questPriority = to;
	appendJourneyByPath(entry.dir, `Moved from ${from} to ${to}.`);
	return ok(`Quest ${questId} is now ${to} (was ${from}).`, { from, to });
}

/** Shift a quest one priority bucket up or down: the one named, or the loaded one. */
export function priorityShift(
	state: QuestState,
	direction: "up" | "down",
	params?: QuestToolParams,
): QuestResult {
	// promote and demote are relative one-tier moves; a supplied
	// priority is ambiguous, so refuse rather than silently ignore it.
	// To land in a specific bucket, use drive, park or defer.
	if (params?.priority !== undefined) {
		return refuse(
			`${direction === "up" ? "promote" : "demote"} moves one tier relative and takes no \`priority\`. Use drive, park or defer to jump to a specific bucket.`,
		);
	}
	const op = direction === "up" ? "promote" : "demote";
	return movePriority(state, op, params, (from) => {
		const at = LADDER.indexOf(from);
		const step = direction === "up" ? -1 : 1;
		return LADDER[Math.min(LADDER.length - 1, Math.max(0, at + step))] ?? from;
	});
}

/** Jump a quest straight to a named priority bucket: the one named, or the loaded one. */
export function priorityJump(
	state: QuestState,
	to: QuestPriority,
	params?: QuestToolParams,
): QuestResult {
	return movePriority(state, `move to ${to}`, params, () => to);
}

/**
 * Rank-and-priority verbs: top, bottom, bump, sink,
 * before, after, renumber (sibling rank within a priority
 * bucket), plus promote / demote / drive / park / defer
 * (cross-bucket priority moves).
 */

import type { QuestPriority } from "../../../lib/quest/index.js";
import {
	appendJourneyEntry,
	bumpLoadedPriority,
	type RankAction,
	reorderSiblings,
	setLoadedPriority,
} from "../lifecycle.js";
import type { QuestState } from "../state.js";
import {
	ok,
	type QuestResult,
	type QuestToolParams,
	refuse,
} from "./shared.js";

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
		`Reordered ${result.result.changes.length} quest(s) in the sibling set.`,
		{ changes: result.result.changes },
	);
}

/** Shift the loaded quest one priority bucket up or down. */
export function priorityShift(
	state: QuestState,
	direction: "up" | "down",
	params?: QuestToolParams,
): QuestResult {
	if (!state.questId) return refuse("Load a quest first.");
	// promote and demote are relative one-tier moves; a supplied
	// priority is ambiguous, so refuse rather than silently ignore it.
	// To land in a specific bucket, use drive, park or defer.
	if (params?.priority !== undefined) {
		return refuse(
			`${direction === "up" ? "promote" : "demote"} moves one tier relative and takes no \`priority\`. Use drive, park or defer to jump to a specific bucket.`,
		);
	}
	const result = bumpLoadedPriority(state, direction);
	if (!result.ok) return refuse(result.guidance);
	if (result.from === result.to) {
		return ok(
			direction === "up"
				? `Already at the top of the priority ladder (${result.from}).`
				: `Already at the bottom of the priority ladder (${result.from}).`,
			{ from: result.from, to: result.to },
		);
	}
	appendJourneyEntry(state, `Moved from ${result.from} to ${result.to}.`);
	return ok(
		`Quest ${state.questId} is now ${result.to} (was ${result.from}).`,
		{
			from: result.from,
			to: result.to,
		},
	);
}

/** Jump the loaded quest directly to a named priority bucket. */
export function priorityJump(
	state: QuestState,
	to: QuestPriority,
): QuestResult {
	if (!state.questId) return refuse("Load a quest first.");
	const from = state.questPriority ?? "active";
	const result = setLoadedPriority(state, to);
	if (!result.ok) return refuse(result.guidance);
	if (!result.changed) {
		return ok(`Quest ${state.questId} is already ${to}.`, { from, to });
	}
	appendJourneyEntry(state, `Moved from ${from} to ${to}.`);
	return ok(`Quest ${state.questId} is now ${to} (was ${from}).`, { from, to });
}

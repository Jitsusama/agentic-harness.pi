/**
 * Putting a quest's work first in the machine's queue, and back.
 *
 * `queue-first` marks the quest `id` names with `queue: first`, so the
 * builds and checks its sessions run go ahead of other agents' bulk
 * work (after timed work, quick checks and work a session is parked
 * on). `queue-normal` takes the mark off. Either works on any quest,
 * loaded or not, since the orchestrator sets it for a quest it does not
 * run. The quest's Journey says when it changed.
 */

import { appendJourneyByPath } from "../../../lib/internal/quest/append-journey.ts";
import { mutateQuestFrontMatter } from "../../../lib/internal/quest/mutate.ts";
import type { QuestState } from "../state.ts";
import { goesFirst, keepQuestWeights, QUEUE_FIRST } from "../weights.ts";
import { addressOf } from "./address.ts";
import {
	ok,
	type QuestResult,
	type QuestToolParams,
	refuse,
} from "./shared.ts";

/** Put the quest `id` names first in the queue, or take it back. */
export function queueOrder(
	state: QuestState,
	params: QuestToolParams,
	first: boolean,
): QuestResult {
	const verb = first ? "queue-first" : "queue-normal";
	if (!params.id?.trim()) {
		return refuse(
			`Pass the quest as \`id\`: ${verb} always names the quest whose work it moves.`,
		);
	}
	const target = addressOf(state, params.id, { focused: false });
	if ("refusal" in target) return refuse(target.refusal);
	if (target.documentId) {
		return refuse(
			`${target.documentId} is a document; the queue orders a quest's work, so name ${target.questId}.`,
		);
	}
	let changed = false;
	const result = mutateQuestFrontMatter(target.questDir, (fm) => {
		if (goesFirst(fm) === first) return undefined;
		changed = true;
		const { queue: _was, ...rest } = fm._extra ?? {};
		const extra = first ? { ...rest, queue: QUEUE_FIRST } : rest;
		return {
			...fm,
			_extra: Object.keys(extra).length > 0 ? extra : undefined,
		};
	});
	if (!result.ok) return refuse(result.guidance);
	if (!changed) {
		return ok(
			first
				? `${target.questId}'s work already goes first in the machine's queue.`
				: `${target.questId}'s work already takes its turn with the rest.`,
		);
	}
	appendJourneyByPath(
		target.questDir,
		first
			? "Put first in the machine's queue: its builds and checks go ahead of other agents' bulk work."
			: "Taken back out of first place in the machine's queue.",
	);
	keepQuestWeights(state.questsRoot);
	return ok(
		first
			? `${target.questId}'s work now goes first in the machine's queue, after timed work, quick checks and work a session is parked on. queue-normal takes it back.`
			: `${target.questId}'s work takes its turn with the rest again.`,
	);
}

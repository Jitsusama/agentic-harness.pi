/**
 * Mark a quest as orchestrating, or clear the mark.
 *
 * A marked quest's session is the orchestrator of every quest below it
 * (see lib/internal/quest/orchestration.ts), so marking one quest is
 * all the wiring an orchestration needs: the sessions on the quests
 * below join its group and name it in their presence the next time
 * they publish. The mark is a role of the quest, not of a session, so
 * it outlives reloads and a new session taking the quest over.
 */

import { appendJourneyByPath } from "../../../lib/internal/quest/append-journey.ts";
import { mutateQuestFrontMatter } from "../../../lib/internal/quest/mutate.ts";
import { orchestrates } from "../../../lib/internal/quest/orchestration.ts";
import { questAddress } from "../../../lib/mesh/address.ts";
import { orchestrationGroup } from "../../../lib/mesh/scope.ts";
import type { QuestFrontMatter } from "../../../lib/quest/types.ts";
import type { QuestState } from "../state.ts";
import { addressOf } from "./address.ts";
import {
	ok,
	type QuestResult,
	type QuestToolParams,
	refuse,
} from "./shared.ts";

/**
 * Set or clear the `orchestrator` mark on the quest `id` names, else
 * the loaded quest. A document id is refused: only a quest orchestrates.
 */
export function orchestrate(
	state: QuestState,
	params: QuestToolParams,
	on: boolean,
): QuestResult {
	const target = addressOf(state, params.id, { focused: false });
	if ("refusal" in target) return refuse(target.refusal);
	if (target.documentId) {
		return refuse(
			`${target.documentId} is a document; only a quest orchestrates. Name its quest, ${target.questId}, instead.`,
		);
	}
	let changed = false;
	const outcome = mutateQuestFrontMatter(target.questDir, (fm) => {
		if (orchestrates(fm) === on) return undefined;
		changed = true;
		return on ? { ...fm, orchestrator: true } : unmarked(fm);
	});
	if (!outcome.ok) return refuse(outcome.guidance);
	const group = orchestrationGroup(questAddress(target.questId));
	if (!changed) {
		return ok(
			on
				? `${target.questId} already orchestrates; its group is ${group}.`
				: `${target.questId} does not orchestrate; nothing to clear.`,
		);
	}
	appendJourneyByPath(
		target.questDir,
		on
			? `Marked as orchestrating: its session orchestrates the quests below it, in ${group}.`
			: "No longer orchestrating: the quests below it answer to the next orchestrator above, if any.",
	);
	return ok(
		on
			? `${target.questId} now orchestrates. Sessions on the quests below it join ${group} and name it as their orchestrator the next time their presence is published; the session with ${target.questId} loaded plays the role.`
			: `${target.questId} no longer orchestrates. The quests below it answer to the next orchestrator above it, if any, once their presence is next published.`,
	);
}

/** A quest's front matter without the mark, wherever it was kept. */
function unmarked(fm: QuestFrontMatter): QuestFrontMatter {
	const { orchestrator: _dropped, ...rest } = fm;
	if (!rest._extra || !("orchestrator" in rest._extra)) return rest;
	const { orchestrator: _extraDropped, ...extra } = rest._extra;
	return Object.keys(extra).length > 0
		? { ...rest, _extra: extra }
		: { ...rest, _extra: undefined };
}

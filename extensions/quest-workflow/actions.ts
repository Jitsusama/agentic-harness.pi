/**
 * Canonical verb registry for the quest tool. Fully
 * pi-agnostic; most of it lives in agentic-harness.core, and the
 * verbs this package adds on top are appended here.
 */

import {
	QUEST_ACTIONS as CORE_ACTIONS,
	suggestAction as suggestCoreAction,
} from "@jitsusama/agentic-harness.core/quest/actions";

/**
 * Verbs this package has that core's registry does not yet. `retitle`
 * landed here first because the quests under one parent needed new
 * titles the same evening, and a core release waits on a person.
 */
const LOCAL_ACTIONS = ["retitle"] as const;

/** Every action the quest tool takes. */
export const QUEST_ACTIONS = [...CORE_ACTIONS, ...LOCAL_ACTIONS] as const;

/** One action the quest tool takes. */
export type QuestAction = (typeof QUEST_ACTIONS)[number];

/** How much of a local verb a typo must share before it is suggested. */
const SHARED_PREFIX = 3;

/**
 * The action a mistyped one most likely meant, if any is close: core's
 * nearest by edit distance, else a local verb it is the start of.
 */
export function suggestAction(typed: string): string | undefined {
	return (
		suggestCoreAction(typed) ??
		(typed.length >= SHARED_PREFIX
			? LOCAL_ACTIONS.find((action) => action.startsWith(typed))
			: undefined)
	);
}

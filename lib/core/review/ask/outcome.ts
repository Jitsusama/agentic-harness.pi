/**
 * What a round records of one participant's answer.
 *
 * Said once for every round rather than spelled out in each, because
 * each round that spelled it out kept a different part of it: the
 * council kept a failure's usage and advisory, and the judge, critique,
 * audit and stack round dropped both, so a reviewer that spent its whole
 * budget dying at its deadline counted as free.
 */

import type { AskAnswer } from "./council.ts";
import type { ParticipantOutcome } from "./run.ts";

/**
 * The outcome one answer gives its participant: the failure and what
 * it cost when it failed, or the findings it raised with where it was
 * stopped, where it was kept and what it cost. Only what the answer
 * carried is kept.
 */
export function outcomeOf(
	participantId: string,
	answer: AskAnswer,
	findingIds: number[] = [],
): ParticipantOutcome {
	if ("failure" in answer) {
		return {
			participantId,
			findingIds: [],
			failure: answer.failure,
			...(answer.advisory === undefined ? {} : { advisory: answer.advisory }),
			...(answer.usage === undefined ? {} : { usage: answer.usage }),
		};
	}
	return {
		participantId,
		findingIds,
		...(answer.stopped === undefined ? {} : { stopped: answer.stopped }),
		...(answer.answerPath === undefined
			? {}
			: { answerPath: answer.answerPath }),
		...(answer.usage === undefined ? {} : { usage: answer.usage }),
	};
}

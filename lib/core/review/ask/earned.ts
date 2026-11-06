/**
 * Whether another council on a change has earned its cost.
 *
 * A council is the dearest thing the review tools do, and the rounds
 * that buy least are the ones that read what an earlier council read:
 * in the week to 5 November, 15 councils read a commit a council had
 * already read, and 44 came after a change's third, $506 at list. A
 * round like that is refused unless its asker says, in `intent`, what
 * it looks for that the others did not, so asking again is a choice
 * rather than a habit. Every other door stays open: the findings
 * already held, a judge over the latest council, a retry of one
 * reviewer.
 */

import type { AskRun } from "./run.ts";

/** How many councils a change has before another must say what it is for. */
export const COUNCILS_BEFORE_ASKING_WHY = 3;

/**
 * Why a council at `head` is refused, given the rounds the change
 * already holds, or nothing when it may go ahead. A round given an
 * intent always goes ahead. With no head known, only the count says.
 */
export function councilNotEarned(
	earlier: readonly AskRun[],
	head: string | undefined,
	intent: string | undefined,
): string | undefined {
	if (intent !== undefined && intent.trim() !== "") return undefined;
	// A round a person gave up on asked nobody anything worth keeping.
	const councils = earlier.filter(
		(run) => run.round === "council" && run.closed !== true,
	);
	const sameCommit =
		head === undefined
			? undefined
			: councils.find((run) => run.witness === head);
	if (head !== undefined && sameCommit !== undefined) {
		return [
			`A council already read ${head.slice(0, 12)} (${sameCommit.id}), and another would read the same code.`,
			"Read its findings with review_see findings, consolidate them with action judge, or retry one participant.",
			"To ask again at this commit anyway, pass intent saying what this round looks for that the last did not.",
		].join(" ");
	}
	if (councils.length >= COUNCILS_BEFORE_ASKING_WHY) {
		return [
			`This change has had ${councils.length} councils, and a fourth reads mostly what they read.`,
			"Judge the latest with action judge, or retry one participant.",
			"To ask the whole roster again, pass intent saying what is left to look for.",
		].join(" ");
	}
	return undefined;
}

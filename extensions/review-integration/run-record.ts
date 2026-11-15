/**
 * What a settled reviewer tells whatever counts runs: the footer's
 * running total and a row in the run table, as a fleet's subagents do.
 */

import {
	recordRunEverywhere,
	runRecordFrom,
} from "../../lib/core/observability/recorder.ts";
import type { AskRun } from "../../lib/core/review/index.ts";
import type { RunReviewerResult } from "../../lib/subagent/index.ts";

/** What a settled reviewer is worth telling the rest of the harness. */
export interface ReviewerRun {
	runId: string;
	participantId: string;
	model?: string;
	/** The level it was launched at; null when the roster set none. */
	thinkingLevel: string | null;
	startedAt: number;
	result: RunReviewerResult;
}

/**
 * Publish a settled reviewer to whatever is counting runs.
 *
 * The same two calls a fleet makes for each of its subagents, which
 * is what puts a running total in the footer and a row in the run
 * table. The recorder's own docstring has always claimed it covered
 * "both the fleet dispatcher and the council runner", and only the
 * fleet half was ever wired, so the most expensive tool here was the
 * one whose cost nothing showed while it ran.
 *
 * Failures are published too. A reviewer that spent its whole budget
 * to produce nothing is the dearest outcome there is, and a meter
 * that leaves it out understates exactly the round worth knowing
 * about.
 *
 * So is a run nothing priced. Absent is not zero when a round says
 * what it cost, because there the number is the claim; here the row
 * is the claim, and withholding it loses the run itself. The worst
 * failure this repo has recorded, a whole round killed before any
 * reviewer could bill anything, would have been the one event the
 * run table had nothing to say about. The recorder carries zeroes
 * for exactly this and the fleet publishes on the same terms.
 */
export function recordReviewerRun(run: ReviewerRun): void {
	recordRunEverywhere(
		runRecordFrom({
			runId: run.runId,
			subagentId: run.participantId,
			// What tells one kind of round from another, and all of them
			// from a fan-out. Taken from the id the round already mints,
			// so a judge does not file itself as a council.
			kind: roundKind(run.runId),
			model: run.model ?? "",
			// A reviewer's id is its persona here, the way a subagent's
			// id is. The roster's persona field names a charter file,
			// which is a different thing from who was asked.
			persona: run.participantId,
			thinkingLevel: run.thinkingLevel,
			startedAt: run.startedAt,
			// Passed through rather than projected by hand, which dropped
			// the verification the run table's health columns read.
			result: { ...run.result, warnings: run.result.warnings ?? [] },
		}),
	);
}

/**
 * A collected reviewer, as the round launched it.
 *
 * The model and level are the ones the ledger wrote down before the
 * round asked anybody. A started round launches every reviewer in the
 * same moment, so the round's start is each one's.
 */
export function collectedRun(
	held: AskRun,
	participantId: string,
	result: RunReviewerResult,
): ReviewerRun {
	const participant = held.participants.find((one) => one.id === participantId);
	return {
		runId: held.id,
		participantId,
		...(participant?.model === undefined ? {} : { model: participant.model }),
		// Left unset, the child inherited pi's default, which the round
		// never saw.
		thinkingLevel: participant?.thinkingLevel ?? null,
		startedAt: Date.parse(held.startedAt),
		result,
	};
}

/**
 * Which kind of round an id belongs to.
 *
 * Every round mints `<kind>-<timestamp>-<seq>`, so the kind is
 * already written down and does not need plumbing to the one place
 * that reports it. An id in any other shape files under itself rather
 * than under a guess.
 */
function roundKind(runId: string): string {
	const head = runId.split("-")[0];
	return head === undefined || head === "" ? runId : head;
}

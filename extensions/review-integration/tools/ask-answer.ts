/**
 * How a `review_ask` round's outcome is said and kept: painted for the
 * reader, put on the ledger, and handed on to whoever judges it.
 *
 * Apart from ask.ts because both the rounds that run and the rounds
 * settled afterwards (ask-settle.ts) end by saying what happened, and
 * neither should import the other to do it.
 */

import {
	type AnswerContext,
	type AnswerLine,
	type AskRun,
	type ChangeRef,
	createRunStore,
	roundAnswer,
} from "../../../lib/core/review/index.ts";
import { runDir } from "../engine.ts";
import { GLYPH } from "../render.ts";
import { messageOf } from "./shared.ts";

/**
 * What to do with what a judge concluded, said where it is concluded.
 *
 * A judge's findings read as settled, and they are not: a judge
 * consolidates what reviewers believed, and both can be wrong about
 * the code. Taking them at their word and fixing each in turn patches
 * symptoms one by one. Said here because it had to be asked for after
 * nearly every round, which is the sign it belongs in the answer.
 */
export function judgeHandOff(run: AskRun): string[] {
	const found = run.outcomes.reduce(
		(sum, outcome) => sum + outcome.findingIds.length,
		0,
	);
	if (run.round !== "judge" || found === 0) return [];
	return [
		"",
		"Next: check each finding against the source yourself before deciding it, then group what holds up by root cause and fix the causes rather than each symptom.",
	];
}

/**
 * Put a finished round on the ledger, saying so if it could not be.
 *
 * Never throws. The round has already happened and its findings are
 * already recorded against the change; failing to write the ledger
 * entry loses the index, not the work, and answering with a refusal
 * would hide fifteen minutes of review behind a filesystem error.
 */
export async function keptOnLedger(
	change: ChangeRef,
	run: AskRun,
): Promise<string[]> {
	try {
		await createRunStore(runDir()).keep(change, run);
		return [];
	} catch (error) {
		return [
			`${GLYPH.refused} This round is not on the ledger (${messageOf(error)}), so a judge or a retry will not find it by id. Its findings are recorded against the change regardless.`,
		];
	}
}

/**
 * What a round's answer says, painted.
 *
 * The wording and the order are the library's, and this is only the
 * brush. They were both here once, where nothing could test them, and
 * that is where the two bugs the wiring alone showed were living.
 *
 * GLYPH.failed for a participant, not GLYPH.refused, and the same mark
 * the live panel draws against the same line. A participant whose run
 * broke did not refuse anything, and watching one fail with one mark
 * and then reading the identical fact under another invites the
 * question of whether two things happened to it.
 */
export function answerFor(
	run: AskRun,
	warnings: string[],
	caveat?: string,
	also?: Omit<AnswerContext, "warnings" | "caveat">,
): string {
	const brush: Record<NonNullable<AnswerLine["mark"]>, string> = {
		refused: GLYPH.refused,
		failed: GLYPH.failed,
	};
	return roundAnswer(run, { ...also, warnings, caveat })
		.map((line) =>
			line.mark === undefined ? line.text : `${brush[line.mark]} ${line.text}`,
		)
		.join("\n");
}

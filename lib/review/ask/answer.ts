/**
 * What a round says when somebody reads it back.
 *
 * Composed here rather than where it is printed, because the order and
 * the wording are the parts that go wrong and neither is visible from
 * a test of the extension. A round's arithmetic had cases, its panel
 * had cases, its store had cases, and the paragraph a reader actually
 * sees was assembled in a private function nothing could reach.
 *
 * The view stays out. A line says what kind of thing it is and the
 * side that draws it decides what that looks like, which keeps this
 * module free of glyphs, colour and width while still owning what is
 * said and in what order.
 */

import { count } from "../../ui/index.js";
import type { AskRun } from "./run.js";
import {
	failureLines,
	runSummary,
	staleRuntimeAdvisory,
	stoppedNotes,
} from "./run.js";

/** One line of an answer, and what kind of line it is. */
export interface AnswerLine {
	/**
	 * How to draw it: refused for something that changes how the round
	 * should be read, failed for a participant that did not answer.
	 * Absent for ordinary prose.
	 */
	mark?: "refused" | "failed";
	text: string;
}

/** Anything the caller knows that the round does not. */
export interface AnswerContext {
	/** Warnings gathered while the round ran. */
	warnings?: string[];
	/** Something about the reading itself, such as which tree was cut. */
	caveat?: string;
}

/** One round, in a line, with whatever its stopped reviewers left. */
export function describeRun(run: AskRun): string {
	const summary = runSummary(run);
	const failed = summary.failed > 0 ? `, ${summary.failed} failed` : "";
	// Only a council carries this, and only while it is unsettled, so
	// the sentence says what is actually known: it opened and nothing
	// closed it. Whether that is a dead session or a round still
	// running in another window is not ours to assert, and the useful
	// half is the same either way, since the reviewers' answers are on
	// disk under this id.
	//
	// Its arithmetic used to be a finished round's, and read as an
	// accusation: a round that opened and has recorded nothing rendered
	// as "0/7 answered, 7 failed", which says seven reviewers were
	// asked and dropped. Nobody has asked them anything yet. The
	// summary now separates the two, so this only has to say it.
	const pending =
		summary.pending > 0 ? `, ${summary.pending} still to hear from` : "";
	const abandoned =
		run.closed === true
			? ", closed unfinished"
			: run.open === true
				? ", opened and never settled"
				: "";
	const head = `${run.id}: ${summary.answered}/${summary.asked} answered${failed}${pending}, ${count(summary.findings, "finding")}${abandoned}`;
	// A stopped reviewer's answer was being recorded and never shown,
	// which is most of the way to losing it: the path is only useful to
	// somebody who knows to look for it.
	return [head, ...stoppedNotes(run).map((note) => `  ${note}`)].join("\n");
}

/** What a round's answer says, in order. */
export function roundAnswer(run: AskRun, said?: AnswerContext): AnswerLine[] {
	const summary = runSummary(run);
	const lines: AnswerLine[] = [{ text: describeRun(run) }];
	// Before everything, not after: a caveat about which tree was read
	// changes how every finding below it should be weighed.
	if (said?.caveat !== undefined) {
		lines.push({ mark: "refused", text: said.caveat });
	}
	// Above the roll call rather than among it, and the roll call says
	// "as above" instead of repeating the paragraph, or hoisting a
	// sentence already on every outcome would make a seven-reviewer
	// round eight copies long rather than one.
	const advisory = staleRuntimeAdvisory(run);
	if (advisory !== undefined) lines.push({ mark: "refused", text: advisory });
	for (const line of failureLines(run)) {
		lines.push({ mark: "failed", text: line });
	}
	const nothing = nothingCameBack(run, summary.answered, summary.failed);
	if (nothing !== undefined) lines.push({ text: nothing });
	for (const warning of said?.warnings ?? []) lines.push({ text: warning });
	return lines;
}

/**
 * That the round came back with nothing, when it did, said after the
 * failures rather than before them.
 *
 * It used to say the failures above were the whole story while being
 * printed above them, and to say it on a round that had failed at
 * nothing: a council that has just opened has answered nobody and
 * blamed nobody, and telling its reader that failures explain the
 * silence invents seven that do not exist.
 */
function nothingCameBack(
	run: AskRun,
	answered: number,
	failed: number,
): string | undefined {
	if (answered > 0) return undefined;
	if (failed > 0) {
		return "Nobody answered, so nothing was recorded. The failures above are the whole story.";
	}
	return run.open === true
		? "Nobody has answered yet, and nothing has gone wrong: the round is still open."
		: "Nobody answered, and nothing was recorded to say why.";
}

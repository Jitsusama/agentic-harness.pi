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

// The leaf, not the barrel. `lib/ui/index.ts` re-exports the panel,
// which imports pi's TUI at module scope, and an ESM re-export
// evaluates what it re-exports from: one convenient import here would
// put pi's runtime in the module graph of a library that has never
// needed it. Every other `count` consumer in `lib/` takes the leaf
// for the same reason.
import { count } from "../../ui/count.js";
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
	/**
	 * Warnings gathered while the round ran.
	 *
	 * Taken as they are and put last. These arrive already painted by
	 * some callers, which is the one place the no-view rule leaks, and
	 * it leaks inward: this module still paints nothing.
	 */
	warnings?: string[];
	/** Something about the reading itself, such as which tree was cut. */
	caveat?: string;
	/**
	 * That somebody answered in this exchange, which disproves anything
	 * the round says about the session being unable to run reviewers.
	 *
	 * The sequence the advisory exists for ends here: pi dies mid-round,
	 * the reader restarts, the reader retries, and the retry works.
	 * Every outcome that failed still carries the diagnosis, because
	 * they did fail, but printing it over a reviewer that has just
	 * answered tells somebody to restart a session they have already
	 * restarted and that is demonstrably fine.
	 */
	sessionAnswered?: boolean;
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
	// One element per line, because a mark paints a line: an element
	// holding two would put the glyph on the first and leave the second
	// looking like prose.
	const lines: AnswerLine[] = describeRun(run)
		.split("\n")
		.map((text) => ({ text }));
	// Before everything, not after: a caveat about which tree was read
	// changes how every finding below it should be weighed.
	if (said?.caveat !== undefined) {
		lines.push({ mark: "refused", text: said.caveat });
	}
	// Above the roll call rather than among it, and the roll call says
	// "as above" instead of repeating the paragraph, or hoisting a
	// sentence already on every outcome would make a seven-reviewer
	// round eight copies long rather than one.
	const advisory =
		said?.sessionAnswered === true ? undefined : staleRuntimeAdvisory(run);
	if (advisory !== undefined) lines.push({ mark: "refused", text: advisory });
	// Told what was hoisted rather than deciding it again, so a
	// suppressed advisory cannot leave a roll call of reviewers
	// pointing at a line that is not there.
	const failures = failureLines(run, advisory);
	for (const line of failures) lines.push({ mark: "failed", text: line });
	const nothing = nothingCameBack(run, summary.answered, failures.length);
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
 *
 * Counted off the failures actually printed rather than off the
 * summary. The two disagree on a settled round with a silent
 * participant, which the summary calls failed and the roll call
 * cannot name, and the sentence points at the roll call.
 *
 * An open round is the third case and the one the collect path
 * reaches: every participant carries a failure saying nothing was on
 * disk, and the warnings under it say the transcripts may be
 * somewhere else and the round is deliberately left open. Calling
 * that the whole story contradicts the next line down.
 */
function nothingCameBack(
	run: AskRun,
	answered: number,
	named: number,
): string | undefined {
	if (answered > 0) return undefined;
	if (run.open === true) {
		return named > 0
			? "Nothing came back from anybody, and the round is still open, so what is above may not be the end of it."
			: "Nobody has answered yet, and nothing has gone wrong: the round is still open.";
	}
	return named > 0
		? "Nobody answered, so nothing was recorded. The failures above are the whole story."
		: "Nobody answered, and nothing was recorded to say why.";
}

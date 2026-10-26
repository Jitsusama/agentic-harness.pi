/**
 * The one line every check answers with.
 *
 * Five kinds of check produce five shapes of evidence, and a
 * reader should not have to learn five ways of asking "is this
 * all right". Every one of them now opens with the same three
 * words and the same headline.
 *
 * A clean result reports what was measured rather than saying
 * nothing. "No violations" and "no violations across 340
 * elements and 91 rules" are the same verdict and very different
 * reassurances: the first is what a broken checker also says.
 */

/** How a check came out. */
export type Standing = "pass" | "warn" | "fail";

/**
 * Say a count with the noun that agrees with it.
 *
 * Lives with the verdict rather than in one report, because every
 * check writes these sentences and "1 stops are hard to follow"
 * is the kind of thing that makes a reader trust the numbers less
 * than they should.
 */
export function count(many: number, one: string, plural = `${one}s`): string {
	return `${many} ${many === 1 ? one : plural}`;
}

/** The verb that agrees with a count, for the same reason. */
export function wasWere(many: number): string {
	return many === 1 ? "was" : "were";
}

/** The head of any check's answer. */
export interface Verdict {
	readonly standing: Standing;
	/** One line, said plainly, with the numbers behind it. */
	readonly headline: string;
	/** What was looked at, so a clean pass is not a shrug. */
	readonly measured?: string;
}

const MARK: Readonly<Record<Standing, string>> = {
	pass: "PASS",
	warn: "WARN",
	fail: "FAIL",
};

/** Put a verdict at the head of a report. */
export function renderVerdict(verdict: Verdict, body: string): string {
	const head = `${MARK[verdict.standing]}  ${verdict.headline}`;
	const measured =
		verdict.measured === undefined ? "" : `\n${verdict.measured}`;
	return body === "" ? `${head}${measured}` : `${head}${measured}\n\n${body}`;
}

/**
 * Whether anything found was severe enough to fail.
 *
 * A thing nobody could decide is a warning, never a pass. That
 * is the whole reason it is reported separately: an automated
 * check that turns its own uncertainty into approval is worse
 * than no check.
 */
export function standingFor(counts: {
	readonly failures: number;
	readonly warnings: number;
}): Standing {
	if (counts.failures > 0) return "fail";
	return counts.warnings > 0 ? "warn" : "pass";
}

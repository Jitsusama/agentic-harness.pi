/**
 * Wording rules for a section, kept to the ones that are always right.
 *
 * A gate that refuses an honest sentence teaches the writer to dodge a
 * word rather than to say something truer, and a writer who has been
 * refused wrongly once stops trusting the rest. So a rule lives here
 * only if every sentence it matches is the problem it names. Two do:
 *
 * - A TL;DR that opens with "This PR", "This change" or the like. The
 *   opening words are what a scanning reader takes in, and these name
 *   the container instead of what changed.
 * - Bold in the TL;DR, which is already the most prominent text on the
 *   page.
 *
 * The judgements that need a reader live in the github-pr-format skill
 * instead: whether a claim is scoped, whether the Solution gives its
 * reasons, whether Validation hedges. Word lists for those were tried
 * and measured on 76 PR descriptions and 4,400 sentences they were not
 * tuned on. A repeated-opener rule matched only "a", "the", "it" and
 * "at"; a scope rule matched about 3 overclaims in 45 sampled hits,
 * almost all of the rest literally true ("after every test"); a hedge
 * rule matched "the line most likely to exceed the cap"; and none of
 * them caught a TL;DR that claimed more than its Solution, which used
 * none of their words.
 */

/** The wording rules a section can be held to. */
export interface SectionWording {
	/** Open with what changed rather than "This PR", and use no bold. */
	readonly headline?: boolean;
}

/** Which wording rule a sentence broke. */
export type WordingRule = "opener" | "emphasis";

/** One wording problem: the rule, the word that tripped it and where. */
export interface WordingProblem {
	readonly rule: WordingRule;
	/** The word or phrase that broke the rule. */
	readonly word: string;
	/** The line it sits in, when there is one. */
	readonly sentence?: string;
}

const OPENER =
	/^(this (?:pr|pull request|change|commit)|in this (?:pr|change))\b/i;
const LIST_ITEM = /^\s*(?:[-*+]|\d+\.)\s+/;
const EMPHASIS = /\*\*|__/;

/**
 * Every wording problem in one section's prose, in reading order. The
 * prose is the section with context lines and fenced code already
 * taken out.
 */
export function wordingProblems(
	prose: string,
	rules: SectionWording,
): WordingProblem[] {
	const found: WordingProblem[] = [];
	if (!rules.headline) return found;

	const first =
		prose
			.split("\n")
			.find((l) => l.trim() && !LIST_ITEM.test(l))
			?.trim() ?? "";
	const opener = OPENER.exec(first);
	if (opener) {
		found.push({
			rule: "opener",
			word: opener[1] ?? opener[0],
			sentence: first,
		});
	}
	if (EMPHASIS.test(prose)) found.push({ rule: "emphasis", word: "**" });
	return found;
}

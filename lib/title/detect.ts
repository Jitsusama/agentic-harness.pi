/**
 * Title convention detection: finds the mechanically certain
 * violations of the PR and issue title convention so a guardian
 * can block and point the author at the skill. Detection never
 * rewrites; it names what is wrong and leaves the descriptive
 * rephrasing to the author.
 */

import type { Violation } from "../gate/index.js";

/** A single title convention violation. */
export interface TitleViolation extends Violation {
	readonly kind: "title";
	/**
	 * conventional-commit: the title uses `type(scope): ...` form.
	 * over-length: the title exceeds the upper-bound character limit.
	 * sentence-case: the title reads as a sentence, not Title Case.
	 */
	readonly issue: "conventional-commit" | "over-length" | "sentence-case";
	/**
	 * The offending prefix (conventional-commit) or a description of
	 * the length and the limit (over-length).
	 */
	readonly found: string;
}

/**
 * The upper bound the gate enforces on title length. The skills
 * state a 50 to 72 range; the gate enforces the upper bound only
 * because the lower bound is guidance (short descriptive titles
 * like "Add Dark Mode Toggle" are fine, and the cli convention's
 * own good example is 40 characters). 72 is the hard cap: past it
 * the title truncates in GitHub views and reads badly in logs.
 */
const MAX_TITLE_LENGTH = 72;

// The conventional-commit type words. A title that opens with one
// of these followed by an optional `(scope)`, an optional `!` and
// a colon is conventional-commit format, which the title
// convention forbids. Anchoring on the known type list keeps the
// match precise: a descriptive title with a non-type colon prefix
// (`Gitstream: ...`) never matches, because the word before the
// colon is not a type.
const CONVENTIONAL_COMMIT_TYPES = [
	"feat",
	"fix",
	"chore",
	"docs",
	"refactor",
	"perf",
	"test",
	"build",
	"ci",
	"style",
	"revert",
	"wip",
	"merge",
	"release",
	"bump",
	"deps",
	"hotfix",
];
// `type` then optional `(scope)`, optional `!`, then `:`. Matched
// case-insensitively so `Fix:` and `FEAT:` are caught too.
const CONVENTIONAL_COMMIT = new RegExp(
	`^(?:${CONVENTIONAL_COMMIT_TYPES.join("|")})(?:\\([^)]*\\))?!?:`,
	"i",
);

// The minor words Title Case leaves lowercase unless they open or
// close the title: articles, the short prepositions and the
// coordinating conjunctions the markdown-standard skill names.
// They are neither a capitalized nor a lowercase major word, so
// they sit out the sentence-case count entirely.
const MINOR_WORDS = new Set([
	"a",
	"an",
	"the",
	"of",
	"in",
	"on",
	"at",
	"to",
	"for",
	"with",
	"by",
	"from",
	"as",
	"and",
	"or",
	"but",
	"nor",
	"so",
	"yet",
]);

// A word that is exempt from the case test because the convention
// keeps it verbatim by its punctuation: backticked code and
// dotted or slashed identifiers (vantage.Prepare, site/host).
// Mixed-case tokens (iOS, CamelCase, V1) are not handled here;
// the case loop below reads their inner capital and leaves them
// out of the lowercase count.
function isVerbatimToken(word: string): boolean {
	return /[`./]/.test(word);
}

/** Find the mechanically certain title convention violations. */
export function detectTitleViolations(title: string): TitleViolation[] {
	const trimmed = title.trim();
	const violations: TitleViolation[] = [];

	const match = trimmed.match(CONVENTIONAL_COMMIT);
	if (match) {
		violations.push({
			kind: "title",
			issue: "conventional-commit",
			found: match[0],
		});
	}

	if (trimmed.length > MAX_TITLE_LENGTH) {
		violations.push({
			kind: "title",
			issue: "over-length",
			found: `${trimmed.length} characters (limit ${MAX_TITLE_LENGTH})`,
		});
	}

	const sentenceCase = detectSentenceCase(trimmed);
	if (sentenceCase) violations.push(sentenceCase);

	return violations;
}

/**
 * Flag a title that reads as a sentence rather than Title Case.
 *
 * Detection is precision-over-recall: it counts the major words
 * (everything that is not a minor word or a verbatim token) and
 * splits them into capitalized and lowercase. A title is only
 * flagged when its lowercase major words number at least two and
 * outnumber the capitalized ones, the unambiguous signal of
 * sentence case. A mostly-Title-Case title that carries one or
 * two deliberately lowercase proper nouns (gitstream, gsperf)
 * never trips, because those never outnumber the capitalized
 * words around them.
 */
function detectSentenceCase(title: string): TitleViolation | undefined {
	let capitalized = 0;
	const lowercase: string[] = [];

	for (const raw of title.split(/\s+/)) {
		// Strip surrounding punctuation (quotes, parens, a trailing
		// colon) but keep internal dots, slashes and hyphens.
		const word = raw.replace(/^[^\p{L}\p{N}`]+|[^\p{L}\p{N}`]+$/gu, "");
		if (!word) continue;
		if (!/\p{L}/u.test(word)) continue; // pure number or symbol
		if (MINOR_WORDS.has(word.toLowerCase())) continue;
		if (isVerbatimToken(word)) continue;

		const firstLetter = word.match(/\p{L}/u)?.[0] ?? "";
		const startsUpper = firstLetter === firstLetter.toUpperCase();
		const hasUpper = /\p{Lu}/u.test(word);

		if (startsUpper) {
			capitalized++;
		} else if (!hasUpper) {
			// Lowercase first letter and no inner capital: a plain
			// lowercase word. A mixed-case token (iOS) has an inner
			// capital and is left verbatim.
			lowercase.push(word);
		}
	}

	if (lowercase.length >= 2 && lowercase.length > capitalized) {
		return {
			kind: "title",
			issue: "sentence-case",
			found: lowercase.join(", "),
		};
	}
	return undefined;
}

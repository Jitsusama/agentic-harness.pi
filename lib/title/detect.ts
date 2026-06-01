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
	 */
	readonly issue: "conventional-commit" | "over-length";
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

	return violations;
}

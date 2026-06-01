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
	/** conventional-commit: the title uses `type(scope): ...` form. */
	readonly issue: "conventional-commit";
	/** The offending prefix (e.g. `chore(monitoring):`). */
	readonly found: string;
}

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
	const match = trimmed.match(CONVENTIONAL_COMMIT);
	if (!match) return [];
	return [{ kind: "title", issue: "conventional-commit", found: match[0] }];
}

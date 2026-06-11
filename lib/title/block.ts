/**
 * Turns detected title violations into a single skill-grounded
 * instruction the guardian hands back to the author. It names the
 * offending prefix and points at the format skill so the retry is
 * a descriptive rewrite, not a guess.
 */

import type { TitleViolation } from "./detect.js";

/** Format title violations into a block message, or "" if none. */
export function formatTitleBlock(
	violations: TitleViolation[],
	entityLabel: string,
	skill: string,
): string {
	if (violations.length === 0) return "";

	const lines: string[] = [
		`This ${entityLabel} title breaks the ${skill} title convention.`,
		"Fix it and try again.",
		"",
	];

	const prefixes = violations
		.filter((v) => v.issue === "conventional-commit")
		.map((v) => v.found);
	if (prefixes.length > 0) {
		lines.push(
			`Conventional commit format (${prefixes.join(", ")}) is forbidden`,
			"for titles. Use a descriptive Title Case title that names the",
			"value, not the implementation, and drop the type prefix. For",
			'example "Add Token Refresh to Prevent Session Timeouts" rather',
			'than "feat(auth): implement refresh token logic".',
			"",
		);
	}

	const sentenceCase = violations.find((v) => v.issue === "sentence-case");
	if (sentenceCase) {
		lines.push(
			"The title reads as a sentence, not Title Case. These major",
			`words are lowercase: ${sentenceCase.found}. Capitalize every`,
			"noun, verb, adjective, adverb and pronoun; leave only articles,",
			"short prepositions and coordinating conjunctions lowercase. A",
			"deliberately lowercase proper noun (gitstream, gsperf) can stay",
			"lowercase; it is the run of ordinary words that needs fixing.",
			"",
		);
	}

	const tooLong = violations.find((v) => v.issue === "over-length");
	if (tooLong) {
		lines.push(
			`The title is ${tooLong.found.replace(" (limit ", ", over the limit of ").replace(")", "")}.`,
			"Trim it to a tight Title Case summary. The lower bound the skill",
			"suggests (50 characters) is guidance; the upper bound is",
			"enforced because longer titles truncate in GitHub views and read",
			"badly in logs.",
			"",
		);
	}

	lines.push(
		`See the ${skill} and github-cli-convention skills for the title`,
		"rules (Title Case, length, the formula).",
	);

	return lines.join("\n");
}

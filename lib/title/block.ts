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

	const prefixes = violations
		.filter((v) => v.issue === "conventional-commit")
		.map((v) => v.found);

	const lines: string[] = [
		`This ${entityLabel} title uses conventional commit format`,
		`(${prefixes.join(", ")}), which the ${skill} skill forbids for`,
		"titles. Use a descriptive Title Case title that names the value,",
		"not the implementation, and drop the type prefix. For example",
		'"Add Token Refresh to Prevent Session Timeouts" rather than',
		'"feat(auth): implement refresh token logic". Fix the title and',
		"try again.",
		"",
		`See the ${skill} and github-cli-convention skills for the title`,
		"rules (Title Case, length, the formula).",
	];

	return lines.join("\n");
}

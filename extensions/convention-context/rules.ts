/**
 * The resident binding-rules block. A compact reminder of the
 * conventions the gates enforce, injected into the system prompt
 * every turn so the AI gets them right the first time and the
 * gate has less to block. The block is resident and
 * compaction-immune by virtue of riding the resident prompt
 * coordinator, so it survives the context eviction that drops a
 * skill body mid-session.
 *
 * The PR and issue section lists are built from the same
 * constants the section gate enforces, so the reminder and the
 * gate cannot drift. The prose, commit and Slack lines are kept
 * terse on purpose: this rides every prompt, so it must not
 * balloon the default context. The named skills carry the full
 * rules; this only points at them.
 *
 * One line here is not about what to write but about which tool
 * to reach for. It earns its place because a skill description
 * only helps somebody who goes looking for a skill, and the
 * failure it prevents is reaching for `gh pr create` without
 * ever wondering whether something else was meant. That happened
 * repeatedly in one session, in a repo where `gh` cannot see the
 * changes it was being asked to make.
 */

import {
	ISSUE_SECTIONS,
	PR_SECTIONS,
	PR_SHAPE,
} from "../../lib/core/sections/index.ts";

/**
 * The PR shape in one line, from the same limits the gate holds a
 * body to. A model that knows the TL;DR has 40 words writes 40; one
 * that finds out from a refusal writes it twice.
 */
function prShapeLine(): string {
	const [tldr, problem, solution, validation] = PR_SECTIONS.map(
		(heading) => PR_SHAPE.sections[heading] ?? {},
	);
	return [
		"- PR shape, for a reader who skips the diff; word ceilings, not targets:",
		`TL;DR ${tldr?.words} in ${tldr?.sentences} sentences, opening with what changed, no code or links;`,
		`Problem ${problem?.words}, prose; Solution ${solution?.words}; Validation ${validation?.words}.`,
		"review_offer takes problem, solution, validation, tldr.",
		"Only counts are checked: before sending, check the Solution backs every TL;DR claim.",
	].join(" ");
}

/** Build the resident binding-rules block. */
export function buildBindingRules(): string {
	return [
		"## Authoring Conventions (Enforced at the Gate)",
		"",
		"When you author a PR, issue, commit, review comment or Slack",
		"message here, these are enforced: a violation is blocked and",
		"you are pointed at the skill. Get them right up front.",
		"",
		`- Prose (prose-standard): Canadian spelling; never an emdash (or the \\u2014 escape), curly quotes or the Unicode ellipsis; no markdown emphasis or backticks in running prose.`,
		`- PR body (github-pr-format): exactly these sections, verbatim, nothing else: ${PR_SECTIONS.join(", ")}.`,
		prShapeLine(),
		`- Issue body (github-issue-format): exactly these, verbatim, nothing else: ${ISSUE_SECTIONS.join(", ")}.`,
		"- Commit (commit-format): conventional `type(scope): subject`; the body says why, not what.",
		"- Slack (slack-guide): no markdown pipe tables (use the table parameter), no image embeds (upload instead), well-formed lists.",
		"- Opening a PR (review-guide): `review_offer propose`, never `gh pr create`. Same conventions either way, and `gh` cannot see a gitstream-native change.",
	].join("\n");
}

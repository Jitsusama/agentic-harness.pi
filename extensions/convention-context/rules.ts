/**
 * The resident binding-rules block. A compact reminder of the
 * conventions the gates enforce, injected into the system prompt
 * every turn so the AI gets them right the first time and the
 * gate has less to block. The block is resident and
 * compaction-immune by virtue of riding before_agent_start, so
 * it survives the context eviction that drops a skill body
 * mid-session.
 *
 * The PR and issue section lists are built from the same
 * constants the section gate enforces, so the reminder and the
 * gate cannot drift. The prose, commit and Slack lines are kept
 * terse on purpose: this rides every prompt, so it must not
 * balloon the default context. The named skills carry the full
 * rules; this only points at them.
 */

import { ISSUE_SECTIONS, PR_SECTIONS } from "../../lib/sections/index.js";

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
		`- Issue body (github-issue-format): exactly these, verbatim, nothing else: ${ISSUE_SECTIONS.join(", ")}.`,
		"- Commit (commit-format): conventional `type(scope): subject`; the body says why, not what.",
		"- Slack (slack-guide): no markdown pipe tables (use the table parameter), no image embeds (upload instead), well-formed lists.",
	].join("\n");
}

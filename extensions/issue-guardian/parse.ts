/**
 * Issue command parsing: re-exports shared utilities from
 * lib/github/cli and adds the issue-specific rebuild helper.
 */

import { rebuildGhCommand } from "../../lib/internal/github/cli.js";

export {
	type IssueCommand,
	isIssueCommand,
	parseIssueCommand,
} from "../../lib/internal/github/cli.js";

import type { IssueCommand } from "../../lib/internal/github/cli.js";

const HEREDOC_DELIM = "__ISSUE_BODY__";

/** Rebuild the command with an edited body. */
export function rebuildCommand(
	parsed: IssueCommand,
	newBody: string,
	newTitle?: string,
): string {
	return rebuildGhCommand({
		entity: "issue",
		action: parsed.action,
		entityNumber: parsed.issueNumber,
		prefix: parsed.prefix,
		extraFlags: parsed.extraFlags,
		title: newTitle ?? parsed.title,
		body: newBody,
		heredocDelim: HEREDOC_DELIM,
	});
}

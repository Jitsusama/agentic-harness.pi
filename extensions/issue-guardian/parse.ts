/**
 * Issue command parsing — extract title, body, and metadata from
 * gh issue create / gh issue edit commands.
 *
 * Delegates common parsing to shared/command-parse. Keeps only
 * issue-specific extra-flag extraction.
 */

import {
	extractBody,
	extractEntityNumber,
	extractFlag,
	extractMultiFlags,
	isGhCommand,
	quote,
	rebuildGhCommand,
	splitAtCommand,
} from "../shared/command-parse.js";

const HEREDOC_DELIM = "__ISSUE_BODY__";

export interface IssueCommand {
	/** "create" or "edit" */
	action: "create" | "edit";
	title: string | null;
	body: string | null;
	/** Everything before the gh issue command (cd, &&, etc.) */
	prefix: string | null;
	/** The full gh issue portion of the command */
	issuePart: string;
	/** Issue number for edit commands */
	issueNumber: string | null;
	/** Extra flags to preserve (--label, --assignee, etc.) */
	extraFlags: string[];
}

/**
 * Detect whether a bash command contains a gh issue create or
 * gh issue edit with body content.
 */
export function isIssueCommand(command: string): boolean {
	return isGhCommand(command, "issue");
}

/**
 * Extract issue details from a bash command.
 */
export function parseIssueCommand(command: string): IssueCommand | null {
	if (!isIssueCommand(command)) return null;

	const { prefix, target: issuePart } = splitAtCommand(
		command,
		/gh\s+issue\s+(?:create|edit)\b/,
	);
	const action = /\bgh\s+issue\s+create\b/.test(issuePart) ? "create" : "edit";

	const title = extractFlag(issuePart, "title");
	const body = extractBody(command, issuePart);
	const issueNumber =
		action === "edit"
			? extractEntityNumber(issuePart, /\bgh\s+issue\s+edit\s+(\d+)\b/)
			: null;
	const extraFlags = extractIssueExtraFlags(issuePart);

	// Only gate if there's a body to review
	if (!body) return null;

	return { action, title, body, prefix, issuePart, issueNumber, extraFlags };
}

/** Extract issue-specific flags to preserve. */
function extractIssueExtraFlags(issuePart: string): string[] {
	const flags: string[] = [];

	// Flags with values (single occurrence)
	for (const flag of ["milestone", "repo"]) {
		const value = extractFlag(issuePart, flag);
		if (value) flags.push(`--${flag}`, quote(value));
	}

	// Multi-value flags
	for (const [name, value] of extractMultiFlags(issuePart, [
		"label",
		"assignee",
		"project",
	])) {
		// edit commands use --add-label, create uses --label
		const prefix = issuePart.includes(`--add-${name}`) ? "add-" : "";
		flags.push(`--${prefix}${name}`, quote(value));
	}

	return flags;
}

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

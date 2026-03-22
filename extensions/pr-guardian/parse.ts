/**
 * PR command parsing: extract title, body, and metadata from
 * gh pr create / gh pr edit commands.
 *
 * Delegates common parsing to lib/parse. Keeps only
 * PR-specific extra-flag extraction.
 */

import {
	extractBody,
	extractFlag,
	quote,
	splitAtCommand,
} from "../lib/parse/command.js";
import {
	extractEntityNumber,
	extractMultiFlags,
	isGhCommand,
	rebuildGhCommand,
} from "../lib/parse/gh-command.js";

const HEREDOC_DELIM = "__PR_BODY__";

export interface PrCommand {
	/** "create" or "edit" */
	action: "create" | "edit";
	title: string | null;
	body: string | null;
	/** Everything before the gh pr command (cd, &&, etc.) */
	prefix: string | null;
	/** The full gh pr portion of the command */
	prPart: string;
	/** PR number for edit commands */
	prNumber: string | null;
	/** Extra flags to preserve (--draft, --base, etc.) */
	extraFlags: string[];
}

/**
 * Detect whether a bash command contains a gh pr create or
 * gh pr edit with body content.
 */
export function isPrCommand(command: string): boolean {
	return isGhCommand(command, "pr");
}

/**
 * Extract PR details from a bash command.
 */
export function parsePrCommand(command: string): PrCommand | null {
	if (!isPrCommand(command)) return null;

	const { prefix, target: prPart } = splitAtCommand(
		command,
		/gh\s+pr\s+(?:create|edit)\b/,
	);
	const action = /\bgh\s+pr\s+create\b/.test(prPart) ? "create" : "edit";

	const title = extractFlag(prPart, "title");
	const body = extractBody(command, prPart);
	const prNumber =
		action === "edit"
			? extractEntityNumber(prPart, /\bgh\s+pr\s+edit\s+(\d+)\b/)
			: null;
	const extraFlags = extractPrExtraFlags(prPart);

	// We only gate if there's a body to review.
	if (!body) return null;

	return { action, title, body, prefix, prPart, prNumber, extraFlags };
}

/** Extract PR-specific flags to preserve. */
function extractPrExtraFlags(prPart: string): string[] {
	const flags: string[] = [];
	if (/--draft\b/.test(prPart)) flags.push("--draft");
	if (/--web\b/.test(prPart)) flags.push("--web");

	// Flags with values
	for (const flag of ["base", "head", "repo", "milestone"]) {
		const value = extractFlag(prPart, flag);
		if (value) flags.push(`--${flag}`, quote(value));
	}

	// Multi-value flags
	for (const [name, value] of extractMultiFlags(prPart, [
		"label",
		"assignee",
		"reviewer",
	])) {
		flags.push(`--add-${name}`, quote(value));
	}

	return flags;
}

/** Rebuild the command with an edited body. */
export function rebuildCommand(
	parsed: PrCommand,
	newBody: string,
	newTitle?: string,
): string {
	return rebuildGhCommand({
		entity: "pr",
		action: parsed.action,
		entityNumber: parsed.prNumber,
		prefix: parsed.prefix,
		extraFlags: parsed.extraFlags,
		title: newTitle ?? parsed.title,
		body: newBody,
		heredocDelim: HEREDOC_DELIM,
	});
}

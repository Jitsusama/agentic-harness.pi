/**
 * GitHub CLI command parsing: detection, entity number extraction,
 * multi-value flag extraction and command rebuilding for gh
 * pr/issue create/edit commands.
 *
 * Depends on shell-level primitives from lib/shell/parse.ts
 * for quoting and heredoc parsing.
 */

import {
	extractBody,
	extractFlag,
	matchHeredocs,
	quote,
	splitAtCommand,
} from "../../shell/parse.js";

/** Extract a number from a command (e.g., PR number from "gh pr edit 42"). */
export function extractEntityNumber(
	commandPart: string,
	pattern: RegExp,
): string | null {
	const match = commandPart.match(pattern);
	return match?.[1] ?? null;
}

/** Detect whether a bash command contains a specific gh subcommand. */
export function isGhCommand(command: string, subcommand: string): boolean {
	const re = new RegExp(`\\bgh\\s+${subcommand}\\s+(create|edit)\\b`);
	return re.test(command);
}

/**
 * Extract shell tokens that follow a heredoc's closing
 * delimiter. Returns null when the command has no heredoc or
 * nothing trails the delimiter line.
 *
 * The closing delimiter is the first line equal to the heredoc
 * word; anything after that line (a `&& git push`, a `;`, a
 * redirect) is the suffix. Without preserving it, a rebuild that
 * reconstructs the command from parsed flags drops it.
 */
export function extractHeredocSuffix(command: string): string | null {
	const heredoc = matchHeredocs(command)[0];
	if (!heredoc) return null;
	const afterDelim = command.slice(heredoc.index + heredoc.length);
	const trimmed = afterDelim.trim();
	return trimmed.length > 0 ? trimmed : null;
}

/**
 * Extract flags that can appear multiple times (--label, --assignee, etc.).
 * Returns an array of [flagName, value] pairs.
 */
export function extractMultiFlags(
	commandPart: string,
	names: string[],
): Array<[string, string]> {
	const results: Array<[string, string]> = [];
	const multiRe = (name: string) =>
		new RegExp(`--(?:add-)?${name}\\s+(?:"([^"]+)"|'([^']+)'|(\\S+))`, "g");

	for (const name of names) {
		const re = multiRe(name);
		for (const match of commandPart.matchAll(re)) {
			const value = match[1] ?? match[2] ?? match[3];
			if (value) results.push([name, value]);
		}
	}
	return results;
}

// ── PR command parsing ──────────────────────────────────────

/** Parsed gh pr create/edit command with extracted fields. */
export interface PrCommand {
	/** "create" or "edit" */
	readonly action: "create" | "edit";
	readonly title: string | null;
	readonly body: string | null;
	/** Everything before the gh pr command (cd, &&, etc.) */
	readonly prefix: string | null;
	/** The full gh pr portion of the command */
	readonly prPart: string;
	/** PR number for edit commands */
	readonly prNumber: string | null;
	/** Extra flags to preserve (--draft, --base, etc.) */
	readonly extraFlags: string[];
	/** Shell tokens after the heredoc closing delimiter (e.g. `&& git push`). */
	readonly suffix: string | null;
	/** Opener-line tokens after the delimiter (e.g. ` 2>&1 | tail -5`). */
	readonly openerRest: string | null;
}

/**
 * Detect whether a bash command contains a gh pr create or
 * gh pr edit with body content.
 */
export function isPrCommand(command: string): boolean {
	return isGhCommand(command, "pr");
}

/** Extract PR details from a bash command. Returns null if no body. */
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
	const suffix = extractHeredocSuffix(command);
	const openerRest = matchHeredocs(command)[0]?.openerRest ?? null;

	// A command with a body parses as before. A title-only edit
	// also parses, with a null body, so the title gate runs on the
	// one path whose sole purpose is changing the title; the
	// body-dependent gates skip a null body downstream. Everything
	// else, a bodyless create or a metadata-only edit, carries no
	// reviewable content here, so leave it ungated.
	if (!body && !(action === "edit" && title)) return null;

	return {
		action,
		title,
		body,
		prefix,
		prPart,
		prNumber,
		extraFlags,
		suffix,
		openerRest,
	};
}

/** Extract PR-specific flags to preserve. */
function extractPrExtraFlags(prPart: string): string[] {
	const flags: string[] = [];
	if (/--draft\b/.test(prPart)) flags.push("--draft");
	if (/--web\b/.test(prPart)) flags.push("--web");

	for (const flag of ["base", "head", "repo", "milestone"]) {
		const value = extractFlag(prPart, flag);
		if (value) flags.push(`--${flag}`, quote(value));
	}

	for (const [name, value] of extractMultiFlags(prPart, [
		"label",
		"assignee",
		"reviewer",
	])) {
		flags.push(`--add-${name}`, quote(value));
	}

	return flags;
}

// ── Issue command parsing ───────────────────────────────────

/** Parsed gh issue create/edit command with extracted fields. */
export interface IssueCommand {
	/** "create" or "edit" */
	readonly action: "create" | "edit";
	readonly title: string | null;
	readonly body: string | null;
	/** Everything before the gh issue command (cd, &&, etc.) */
	readonly prefix: string | null;
	/** The full gh issue portion of the command */
	readonly issuePart: string;
	/** Issue number for edit commands */
	readonly issueNumber: string | null;
	/** Extra flags to preserve (--label, --assignee, etc.) */
	readonly extraFlags: string[];
	/** Shell tokens after the heredoc closing delimiter (e.g. `&& git push`). */
	readonly suffix: string | null;
	/** Opener-line tokens after the delimiter (e.g. ` 2>&1 | tail -5`). */
	readonly openerRest: string | null;
}

/**
 * Detect whether a bash command contains a gh issue create or
 * gh issue edit with body content.
 */
export function isIssueCommand(command: string): boolean {
	return isGhCommand(command, "issue");
}

/** Extract issue details from a bash command. Returns null if no body. */
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
	const suffix = extractHeredocSuffix(command);
	const openerRest = matchHeredocs(command)[0]?.openerRest ?? null;

	// A command with a body parses as before. A title-only edit
	// also parses, with a null body, so the title gate runs on the
	// one path whose sole purpose is changing the title; the
	// body-dependent gates skip a null body downstream. Everything
	// else, a bodyless create or a metadata-only edit, carries no
	// reviewable content here, so leave it ungated.
	if (!body && !(action === "edit" && title)) return null;

	return {
		action,
		title,
		body,
		prefix,
		issuePart,
		issueNumber,
		extraFlags,
		suffix,
		openerRest,
	};
}

/** Extract issue-specific flags to preserve. */
function extractIssueExtraFlags(issuePart: string): string[] {
	const flags: string[] = [];

	for (const flag of ["milestone", "repo"]) {
		const value = extractFlag(issuePart, flag);
		if (value) flags.push(`--${flag}`, quote(value));
	}

	for (const [name, value] of extractMultiFlags(issuePart, [
		"label",
		"assignee",
		"project",
	])) {
		const prefix = issuePart.includes(`--add-${name}`) ? "add-" : "";
		flags.push(`--${prefix}${name}`, quote(value));
	}

	return flags;
}

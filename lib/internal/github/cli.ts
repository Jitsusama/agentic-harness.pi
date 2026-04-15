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

/** Configuration for rebuilding a gh pr/issue command with an edited body. */
export interface GhRebuildConfig {
	/** "pr" or "issue" */
	readonly entity: string;
	/** "create" or "edit" */
	readonly action: string;
	/** Entity number for edit commands. */
	readonly entityNumber?: string | null;
	/** Prefix command (cd /path, etc.) */
	readonly prefix?: string | null;
	/** Extra flags to preserve. */
	readonly extraFlags?: string[];
	/** Title. */
	readonly title?: string | null;
	/** Body content. */
	readonly body: string;
	/** Heredoc delimiter. */
	readonly heredocDelim: string;
}

/** Rebuild a gh command with an edited body. */
export function rebuildGhCommand(config: GhRebuildConfig): string {
	const parts: string[] = ["gh", config.entity, config.action];

	if (config.action === "edit" && config.entityNumber) {
		parts.push(config.entityNumber);
	}

	if (config.extraFlags && config.extraFlags.length > 0) {
		parts.push(...config.extraFlags);
	}

	if (config.title) {
		parts.push("--title", quote(config.title));
	}

	parts.push("--body-file", "-");

	const heredoc = [
		`${parts.join(" ")} <<'${config.heredocDelim}'`,
		config.body,
		config.heredocDelim,
	].join("\n");

	return config.prefix ? `${config.prefix} && ${heredoc}` : heredoc;
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

	if (!body) return null;

	return { action, title, body, prefix, prPart, prNumber, extraFlags };
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

	if (!body) return null;

	return { action, title, body, prefix, issuePart, issueNumber, extraFlags };
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

/**
 * Issue command parsing — extract title, body, and metadata from
 * gh issue create / gh issue edit commands.
 */

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
	return /\bgh\s+issue\s+(create|edit)\b/.test(command);
}

/**
 * Extract issue details from a bash command.
 *
 * Supports:
 *   --body-file - <<'EOF'\nbody\nEOF  (heredoc)
 *   --body "text"  or  --body 'text'
 *   --title "text" or  --title 'text'
 */
export function parseIssueCommand(command: string): IssueCommand | null {
	if (!isIssueCommand(command)) return null;

	const { prefix, issuePart } = splitAtIssue(command);
	const action = /\bgh\s+issue\s+create\b/.test(issuePart) ? "create" : "edit";

	const title = extractFlag(issuePart, "title");
	const body = extractBody(command, issuePart);
	const issueNumber = action === "edit" ? extractIssueNumber(issuePart) : null;
	const extraFlags = extractExtraFlags(issuePart);

	// Only gate if there's a body to review
	if (!body) return null;

	return { action, title, body, prefix, issuePart, issueNumber, extraFlags };
}

/**
 * Split "cd /path && gh issue create ..." into prefix and issue part.
 * Uses greedy match to split at the last separator before gh issue.
 */
function splitAtIssue(command: string): {
	prefix: string | null;
	issuePart: string;
} {
	const match = command.match(
		/^(.*)\s*(?:&&|;)\s*(gh\s+issue\s+(?:create|edit)\b[\s\S]*)$/,
	);
	if (match?.[1]?.trim()) {
		return { prefix: match[1].trim(), issuePart: match[2]! };
	}
	return { prefix: null, issuePart: command };
}

/** Extract the body from a command, supporting heredoc and --body flag. */
function extractBody(fullCommand: string, issuePart: string): string | null {
	// Heredoc: --body-file - <<'DELIM'\nbody\nDELIM
	const heredoc = fullCommand.match(
		/<<-?\s*['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\s*$/,
	);
	if (heredoc) return heredoc[2]!;

	// --body flag
	return extractFlag(issuePart, "body");
}

/** Extract a --flag "value" or --flag 'value' from a command string. */
function extractFlag(command: string, flag: string): string | null {
	// Double-quoted
	const dq = new RegExp(`--${flag}\\s+"((?:[^"\\\\]|\\\\.)*)"`);
	const dqMatch = command.match(dq);
	if (dqMatch) return dqMatch[1]!.replace(/\\(.)/g, "$1");

	// Single-quoted
	const sq = new RegExp(`--${flag}\\s+'([^']*)'`);
	const sqMatch = command.match(sq);
	if (sqMatch) return sqMatch[1]!;

	return null;
}

function quote(s: string): string {
	if (!s.includes("'")) return `'${s}'`;
	return `"${s.replace(/["\\]/g, "\\$&")}"`;
}

/** Extract flags to preserve (--label, --assignee, --milestone, etc.) */
function extractExtraFlags(issuePart: string): string[] {
	const flags: string[] = [];

	// Flags with values (single occurrence)
	for (const flag of ["milestone", "repo"]) {
		const value = extractFlag(issuePart, flag);
		if (value) flags.push(`--${flag}`, quote(value));
	}

	// --label and --assignee can appear multiple times
	const multiRe = (name: string) =>
		new RegExp(`--(?:add-)?${name}\\s+(?:"([^"]+)"|'([^']+)'|(\\S+))`, "g");
	for (const name of ["label", "assignee", "project"]) {
		let match;
		const re = multiRe(name);
		while ((match = re.exec(issuePart)) !== null) {
			const value = match[1] ?? match[2] ?? match[3];
			if (value) {
				// edit commands use --add-label, create uses --label
				const prefix = issuePart.includes(`--add-${name}`) ? "add-" : "";
				flags.push(`--${prefix}${name}`, quote(value));
			}
		}
	}

	return flags;
}

/** Extract the issue number from a gh issue edit command. */
function extractIssueNumber(issuePart: string): string | null {
	const match = issuePart.match(/\bgh\s+issue\s+edit\s+(\d+)\b/);
	return match ? match[1]! : null;
}

/** Rebuild the command with an edited body. */
export function rebuildCommand(
	parsed: IssueCommand,
	newBody: string,
	newTitle?: string,
): string {
	const { action, prefix, issueNumber } = parsed;
	const title = newTitle ?? parsed.title;

	const parts: string[] = ["gh", "issue", action];

	if (action === "edit" && issueNumber) {
		parts.push(issueNumber);
	}

	if (parsed.extraFlags.length > 0) {
		parts.push(...parsed.extraFlags);
	}

	if (title) {
		parts.push("--title", quote(title));
	}

	parts.push("--body-file", "-");

	const heredoc = [
		parts.join(" ") + ` <<'${HEREDOC_DELIM}'`,
		newBody,
		HEREDOC_DELIM,
	].join("\n");

	return prefix ? `${prefix} && ${heredoc}` : heredoc;
}

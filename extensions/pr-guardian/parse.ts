/**
 * PR command parsing — extract title, body, and metadata from
 * gh pr create / gh pr edit commands.
 */

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
	return /\bgh\s+pr\s+(create|edit)\b/.test(command);
}

/**
 * Extract PR details from a bash command.
 *
 * Supports:
 *   --body-file - <<'EOF'\nbody\nEOF  (heredoc)
 *   --body "text"  or  --body 'text'
 *   --title "text" or  --title 'text'
 */
export function parsePrCommand(command: string): PrCommand | null {
	if (!isPrCommand(command)) return null;

	const { prefix, prPart } = splitAtPr(command);
	const action = /\bgh\s+pr\s+create\b/.test(prPart) ? "create" : "edit";

	const title = extractFlag(prPart, "title");
	const body = extractBody(command, prPart);
	const prNumber = action === "edit" ? extractPrNumber(prPart) : null;
	const extraFlags = extractExtraFlags(prPart);

	// Only gate if there's a body to review
	if (!body) return null;

	return { action, title, body, prefix, prPart, prNumber, extraFlags };
}

/**
 * Split "cd /path && gh pr create ..." into prefix and pr part.
 * Uses greedy match to split at the last separator before gh pr.
 */
function splitAtPr(command: string): {
	prefix: string | null;
	prPart: string;
} {
	const match = command.match(
		/^(.*)\s*(?:&&|;)\s*(gh\s+pr\s+(?:create|edit)\b[\s\S]*)$/,
	);
	if (match?.[1]?.trim()) {
		return { prefix: match[1].trim(), prPart: match[2]! };
	}
	return { prefix: null, prPart: command };
}

/** Extract the body from a command, supporting heredoc and --body flag. */
function extractBody(fullCommand: string, prPart: string): string | null {
	// Heredoc: --body-file - <<'DELIM'\nbody\nDELIM
	const heredoc = fullCommand.match(
		/<<-?\s*['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\s*$/,
	);
	if (heredoc) return heredoc[2]!;

	// --body flag
	return extractFlag(prPart, "body");
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

/** Extract flags to preserve (--draft, --base, --head, --repo, etc.) */
function extractExtraFlags(prPart: string): string[] {
	const flags: string[] = [];
	if (/--draft\b/.test(prPart)) flags.push("--draft");
	if (/--web\b/.test(prPart)) flags.push("--web");

	// Flags with values
	for (const flag of ["base", "head", "repo", "milestone"]) {
		const value = extractFlag(prPart, flag);
		if (value) flags.push(`--${flag}`, quote(value));
	}

	// --label and --assignee can appear multiple times
	const multiRe = (name: string) =>
		new RegExp(`--(?:add-)?${name}\\s+(?:"([^"]+)"|'([^']+)'|(\\S+))`, "g");
	for (const name of ["label", "assignee", "reviewer"]) {
		let match;
		const re = multiRe(name);
		while ((match = re.exec(prPart)) !== null) {
			const value = match[1] ?? match[2] ?? match[3];
			if (value) flags.push(`--add-${name}`, quote(value));
		}
	}

	return flags;
}

/** Extract the PR number from a gh pr edit command. */
function extractPrNumber(prPart: string): string | null {
	const match = prPart.match(/\bgh\s+pr\s+edit\s+(\d+)\b/);
	return match ? match[1]! : null;
}

/** Rebuild the command with an edited body. */
export function rebuildCommand(
	parsed: PrCommand,
	newBody: string,
	newTitle?: string,
): string {
	const { action, prefix, prNumber } = parsed;
	const title = newTitle ?? parsed.title;

	const parts: string[] = ["gh", "pr", action];

	if (action === "edit" && prNumber) {
		parts.push(prNumber);
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

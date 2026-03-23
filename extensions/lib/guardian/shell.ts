/**
 * Shell-level command parsing: flag extraction, heredoc parsing,
 * quoting, compound command splitting and git commit command
 * manipulation.
 *
 * These utilities work on raw bash command strings. They know
 * about shell syntax (quoting, heredocs, separators) and git
 * commit commands, but nothing about specific CLI tools like gh.
 */

/** Extract a --flag "value" or --flag 'value' from a command string. */
export function extractFlag(command: string, flag: string): string | null {
	// Double-quoted
	const dq = new RegExp(`--${flag}\\s+"((?:[^"\\\\]|\\\\.)*)"`);
	const dqMatch = command.match(dq);
	if (dqMatch) return dqMatch[1]?.replace(/\\(.)/g, "$1");

	// Single-quoted
	const sq = new RegExp(`--${flag}\\s+'([^']*)'`);
	const sqMatch = command.match(sq);
	if (sqMatch) return sqMatch[1] ?? null;

	// Unquoted (non-whitespace run, stops before shell operators)
	const uq = new RegExp(`--${flag}\\s+(\\S+)`);
	const uqMatch = command.match(uq);
	if (uqMatch) return uqMatch[1] ?? null;

	return null;
}

/** Extract the body from a command, supporting heredoc and --body flag. */
export function extractBody(
	fullCommand: string,
	entityPart: string,
): string | null {
	// Heredoc: --body-file - <<'DELIM'\nbody\nDELIM
	const heredoc = fullCommand.match(
		/<<-?\s*['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\s*$/,
	);
	if (heredoc) return heredoc[2] ?? null;

	// --body flag
	return extractFlag(entityPart, "body");
}

/** Safe shell quoting. */
export function quote(s: string): string {
	if (!s.includes("'")) return `'${s}'`;
	return `"${s.replace(/["\\]/g, "\\$&")}"`;
}

/**
 * Split a compound command at the last separator before the
 * target command. Returns the prefix (everything before) and
 * the target command portion.
 *
 * Separators: `&&`, `;`, and newlines. Newlines are statement
 * separators in shell scripts, just like `;`. Without this,
 * guardians silently drop prefixes when the agent formats
 * commands across multiple lines.
 *
 * Examples:
 *   splitAtCommand("cd /path && gh pr create ...", /gh\s+pr\s+.../)
 *   splitAtCommand("git add -A && git commit ...", /git\s+commit\b/)
 *   splitAtCommand("git checkout branch\ngh pr create ...", /gh\s+pr\s+.../)
 */
export function splitAtCommand(
	command: string,
	targetPattern: RegExp,
): { prefix: string | null; target: string } {
	const source = targetPattern.source;
	// [\s\S]* for the prefix so it matches across newlines.
	// Separators: &&, ;, or newline.
	const re = new RegExp(
		`^([\\s\\S]*)\\s*(?:&&|;|\\n)\\s*(${source}[\\s\\S]*)$`,
	);
	const match = command.match(re);
	if (match?.[1]?.trim()) {
		return { prefix: match[1].trim(), target: match[2] ?? command };
	}
	return { prefix: null, target: command };
}

// ── Git commit command parsing ──────────────────────────────

const COMMIT_HEREDOC_DELIM = "__COMMIT_MSG__";

/**
 * Extract the commit message from a bash command.
 *
 * Supports two formats:
 *   heredoc:  git commit -F- <<'EOF'\nmessage\nEOF
 *   -m flag:  git commit -m "message" or -am "message"
 */
export function extractMessage(command: string): string | null {
	const heredoc = command.match(
		/<<-?\s*['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\s*$/,
	);
	if (heredoc) return heredoc[2] ?? null;

	const normalized = command.replace(/-am\s+/g, "-a -m ");
	const messages: string[] = [];
	const re = /(?:^|\s)-m\s+(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+))/g;
	for (const match of normalized.matchAll(re)) {
		messages.push(
			(match[1] ?? match[2] ?? match[3] ?? "").replace(/\\(.)/g, "$1"),
		);
	}
	return messages.length > 0 ? messages.join("\n\n") : null;
}

/**
 * Split "cd /path && git add -A && git commit ..." into
 * the prefix (everything before git commit) and the commit part.
 */
export function splitAtCommit(command: string): {
	prefix: string | null;
	commitPart: string;
} {
	const { prefix, target } = splitAtCommand(command, /git\s+commit\b/);
	return { prefix, commitPart: target };
}

/** Extract commit flags from the commit portion of the command. */
export function extractCommitFlags(commitPart: string): string[] {
	const flags: string[] = [];
	if (/--amend\b/.test(commitPart)) flags.push("--amend");
	if (/--no-verify\b/.test(commitPart)) flags.push("--no-verify");
	if (/--allow-empty\b/.test(commitPart)) flags.push("--allow-empty");
	if (/--signoff\b|\s-s\b/.test(commitPart)) flags.push("--signoff");
	if (/-a\b/.test(commitPart)) flags.push("-a");
	return flags;
}

/** Build a canonical heredoc commit command from a message and flags. */
export function buildCommitHeredoc(message: string, flags: string[]): string {
	const flagStr = flags.length > 0 ? ` ${flags.join(" ")}` : "";
	return [
		`git commit${flagStr} -F- <<'${COMMIT_HEREDOC_DELIM}'`,
		message,
		COMMIT_HEREDOC_DELIM,
	].join("\n");
}

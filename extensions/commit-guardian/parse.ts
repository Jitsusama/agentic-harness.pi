/**
 * Commit command parsing: extract messages, flags, and
 * prefixes from git commit commands in various formats.
 *
 * Uses splitAtCommand from lib/guardian/shell for prefix
 * splitting. The rest is git-commit-specific (message
 * extraction from -m/-am flags, heredoc format).
 */

import { splitAtCommand } from "../lib/guardian/shell.js";

const HEREDOC_DELIM = "__COMMIT_MSG__";

/**
 * Extract the commit message from a bash command.
 *
 * Supports two formats:
 *   heredoc:  git commit -F- <<'EOF'\nmessage\nEOF
 *   -m flag:  git commit -m "message" or -am "message"
 */
export function extractMessage(command: string): string | null {
	// Heredoc: <<DELIM\nbody\nDELIM
	const heredoc = command.match(
		/<<-?\s*['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\s*$/,
	);
	if (heredoc) return heredoc[2] ?? null;

	// -m flags: -m "msg", -m 'msg', -m msg (also -am "msg")
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
export function extractFlags(commitPart: string): string[] {
	const flags: string[] = [];
	if (/--amend\b/.test(commitPart)) flags.push("--amend");
	if (/--no-verify\b/.test(commitPart)) flags.push("--no-verify");
	if (/--allow-empty\b/.test(commitPart)) flags.push("--allow-empty");
	if (/--signoff\b|\s-s\b/.test(commitPart)) flags.push("--signoff");
	if (/-a\b/.test(commitPart)) flags.push("-a");
	return flags;
}

/** Build a canonical heredoc commit command from a message and flags. */
export function buildHeredoc(message: string, flags: string[]): string {
	const flagStr = flags.length > 0 ? ` ${flags.join(" ")}` : "";
	return [
		`git commit${flagStr} -F- <<'${HEREDOC_DELIM}'`,
		message,
		HEREDOC_DELIM,
	].join("\n");
}

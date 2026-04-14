/**
 * Git commit command parsing: message extraction, commit
 * splitting, flag parsing and heredoc construction.
 *
 * These are commit-guardian internals. General-purpose shell
 * parsing lives in lib/shell/.
 */

import { splitAtCommand } from "../../shell/parse.js";

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
	// Matches both standalone `-a` and combined `-am` forms.
	if (/-a\b|-am\b/.test(commitPart)) flags.push("-a");
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

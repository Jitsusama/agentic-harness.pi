/**
 * Git commit command parsing: message extraction, commit
 * splitting, flag parsing and heredoc construction.
 *
 * These are commit-guardian internals. General-purpose shell
 * parsing lives in lib/shell/.
 */

import { splitAtCommand } from "../../shell/parse.js";

const COMMIT_HEREDOC_DELIM = "__COMMIT_MSG__";

/** Detects the bash heredoc operator (`<<TAG` / `<<'TAG'` / `<<-"TAG"`). */
const HEREDOC_OPERATOR = /<<-?\s*['"]?\w+['"]?/;

/**
 * Extract the commit message from a bash command.
 *
 * Supports two formats:
 *   heredoc:  git commit -F- <<'EOF'\nmessage\nEOF
 *   -m flag:  git commit -m "message" or -am "message"
 *
 * The heredoc regex carries the `m` flag so `$` matches
 * end-of-line, which lets us recognise heredocs even when
 * the bash invocation chains more commands afterwards
 * (`...EOF && echo done`).
 *
 * When a heredoc operator is present but body extraction
 * fails, bail with `null` rather than falling through to
 * `-m` extraction. Otherwise a literal `-m "..."` written
 * inside the heredoc body — e.g. an example commit message
 * quoted in the description — would be picked up as a real
 * flag and silently replace the user's intended message
 * once attribution-interceptor's rewrite kicks in.
 */
export function extractMessage(command: string): string | null {
	const heredoc = command.match(
		/<<-?\s*['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\s*$/m,
	);
	if (heredoc) return heredoc[2] ?? null;

	if (HEREDOC_OPERATOR.test(command)) return null;

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

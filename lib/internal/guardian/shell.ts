/**
 * Git commit command parsing: message extraction, commit
 * splitting, flag parsing and heredoc construction.
 *
 * These are commit-guardian internals. General-purpose shell
 * parsing lives in lib/shell/.
 */

import { matchHeredocs, splitAtCommand } from "../../shell/parse.js";

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
 * The shared `matchHeredocs` primitive recognises heredocs even
 * when the bash invocation chains more commands afterwards
 * (`...EOF && echo done`).
 *
 * When a heredoc operator is present but body extraction
 * fails, bail with `null` rather than falling through to
 * `-m` extraction. Otherwise a literal `-m "..."` written
 * inside the heredoc body — e.g. an example commit message
 * quoted in the description — would be picked up as a real
 * flag and silently replace the user's intended message
 * once attribution-interceptor's rewrite kicks in.
 *
 * A `git commit -F <file>` (a real file, not `-F-` stdin) is
 * resolved through the optional `readFile` reader, which is
 * given the raw path and the command's `cd` base directory and
 * returns the file's contents or null. Without a reader, or when
 * the read fails, this returns null and the caller no-ops, so an
 * unreadable file is a missed gate, never a wrong rewrite.
 */
export function extractMessage(
	command: string,
	readFile?: (rawPath: string, baseDir: string | null) => string | null,
): string | null {
	const heredoc = matchHeredocs(command)[0];
	if (heredoc) return heredoc.body;

	if (HEREDOC_OPERATOR.test(command)) return null;

	const normalized = command.replace(/-am\s+/g, "-a -m ");
	const messages: string[] = [];
	const re = /(?:^|\s)-m\s+(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+))/g;
	for (const match of normalized.matchAll(re)) {
		messages.push(
			(match[1] ?? match[2] ?? match[3] ?? "").replace(/\\(.)/g, "$1"),
		);
	}
	if (messages.length > 0) return messages.join("\n\n");

	return extractFileMessage(command, readFile);
}

/** Match a `-F <path>` or `--file <path>` (or `=path`) commit flag. */
const COMMIT_FILE_FLAG = /(?:-F|--file)(?:\s+|=)("[^"]*"|'[^']*'|\S+)/;
/** Match the first `cd <dir>` in a command, for relative path resolution. */
const CD_TARGET = /(?:^|&&|;|\n)\s*cd\s+("[^"]*"|'[^']*'|\S+)/;

/** Strip one layer of surrounding single or double quotes. */
function unquote(token: string): string {
	return token.replace(/^['"]|['"]$/g, "");
}

/**
 * Resolve a `git commit -F <file>` message through the reader.
 * Returns null when there is no file flag, when the path is `-`
 * (stdin, handled elsewhere), when no reader is supplied, or when
 * the read fails.
 */
function extractFileMessage(
	command: string,
	readFile?: (rawPath: string, baseDir: string | null) => string | null,
): string | null {
	if (!readFile) return null;
	const flag = command.match(COMMIT_FILE_FLAG);
	if (!flag?.[1]) return null;
	const rawPath = unquote(flag[1]);
	if (rawPath === "-") return null;
	const cd = command.match(CD_TARGET);
	const baseDir = cd?.[1] ? unquote(cd[1]) : null;
	const contents = readFile(rawPath, baseDir);
	if (contents === null) return null;
	return contents.replace(/\n+$/, "");
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

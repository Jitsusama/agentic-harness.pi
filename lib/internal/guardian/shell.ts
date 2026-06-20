/**
 * Git commit command parsing: message extraction, commit
 * splitting, flag parsing and heredoc construction.
 *
 * These are commit-guardian internals. General-purpose shell
 * parsing lives in lib/shell/.
 */

import {
	type CommandLine,
	effectiveCwd,
	type FlagSpec,
	findFlag,
	findFlags,
	type SimpleCommand,
	tokenize,
} from "../../command/index.js";
import { splitAtCommand, unquote } from "../../shell/parse.js";

const COMMIT_HEREDOC_DELIM = "__COMMIT_MSG__";

/**
 * The commit flags that carry a message or affect how a clustered
 * short flag like `-am` is read. The message and file flags carry
 * a value; the rest are the common boolean shorts that can precede
 * `-m` in a cluster, so the cluster parses safely.
 */
const COMMIT_MESSAGE_SPEC: FlagSpec = {
	flags: [
		{ name: "message", long: "message", short: "m", takesValue: true },
		{ name: "file", long: "file", short: "F", takesValue: true },
		{ name: "all", long: "all", short: "a", takesValue: false },
		{ name: "signoff", long: "signoff", short: "s", takesValue: false },
		{ name: "verbose", long: "verbose", short: "v", takesValue: false },
		{ name: "quiet", long: "quiet", short: "q", takesValue: false },
		{ name: "edit", long: "edit", short: "e", takesValue: false },
	],
};

/**
 * Extract the commit message from a bash command.
 *
 * Supports the heredoc form (git commit -F- <<'EOF'...EOF), one or
 * more -m/--message flags (including the -am cluster), and a
 * -F <file> read through the optional reader.
 *
 * Parsing runs on the command model, so only the git commit
 * command's own argv and heredoc are read. A -m written inside a
 * heredoc body, or a heredoc belonging to a chained command, is
 * never mistaken for the message, because neither lives in the
 * commit's argv.
 *
 * A `git commit -F <file>` (a real file, not `-F-` stdin) is
 * resolved through the optional `readFile` reader, which is given
 * the raw path and the command's effective working directory and
 * returns the file's contents or null. Without a reader, or when
 * the read fails, this returns null and the caller no-ops, so an
 * unreadable file is a missed gate, never a wrong rewrite.
 */
export function extractMessage(
	command: string,
	readFile?: (rawPath: string, baseDir: string | null) => string | null,
): string | null {
	const line = tokenize(command);
	const commit = line.commands.find(
		(c) => c.argv[0]?.text === "git" && c.argv[1]?.text === "commit",
	);
	if (!commit) return null;

	if (commit.heredoc) {
		return command.slice(
			commit.heredoc.bodySpan.start,
			commit.heredoc.bodySpan.end,
		);
	}

	const messages = findFlags(commit, COMMIT_MESSAGE_SPEC, "message").map((m) =>
		m.value === undefined ? "" : unquote(m.value),
	);
	if (messages.length > 0) return messages.join("\n\n");

	return readFileMessage(line, commit, readFile);
}

/**
 * Resolve a `git commit -F <file>` message through the reader.
 * Returns null when there is no file flag, when the path is `-`
 * (stdin, handled elsewhere), when no reader is supplied, or when
 * the read fails.
 */
function readFileMessage(
	line: CommandLine,
	commit: SimpleCommand,
	readFile?: (rawPath: string, baseDir: string | null) => string | null,
): string | null {
	if (!readFile) return null;
	const flag = findFlag(commit, COMMIT_MESSAGE_SPEC, "file");
	if (!flag || flag.value === undefined) return null;
	const rawPath = unquote(flag.value);
	if (rawPath === "-") return null;
	// Resolve the relative path against the command's effective
	// working directory (the pi cwd composed with any leading cd
	// segments). An unresolvable cd chain falls back to the process
	// cwd reader-side.
	const cwd = effectiveCwd(line, process.cwd());
	const baseDir = "dir" in cwd ? cwd.dir : null;
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

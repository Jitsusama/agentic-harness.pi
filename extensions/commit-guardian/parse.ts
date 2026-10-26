/**
 * Commit command parsing: re-exports shared utilities from
 * lib/guardian/shell and adds the commit-guardian-specific
 * detect function and where a commit lands.
 */

import { resolve } from "node:path";
import { effectiveCwd, tokenize } from "../../lib/command/index.ts";
import {
	findGitCommand,
	isGitCommitCommand,
} from "../../lib/core/internal/guardian/commit-shell.ts";
import { unquote } from "../../lib/shell/index.ts";

export { extractMessage } from "../../lib/core/internal/guardian/commit-shell.ts";

/**
 * Detect whether a bash command contains a git commit. Routes
 * through the command model so a commit reached past leading git
 * global options (git -C dir commit) is still detected.
 */
export function isCommitCommand(command: string): boolean {
	return isGitCommitCommand(command);
}

/**
 * The directory a commit runs in: the session's directory moved by
 * any `cd` before it, then by each `git -C` it carries, as git applies
 * them. Undefined when a `cd` cannot be resolved, so a reader judges
 * every tree rather than guessing one.
 */
export function commitDirectory(
	command: string,
	base: string = process.cwd(),
): string | undefined {
	const line = tokenize(command);
	const commit = findGitCommand(line, "commit");
	if (!commit) return undefined;
	const cwd = effectiveCwd(line, base, commit.span.start);
	if (!("dir" in cwd)) return undefined;
	let dir = cwd.dir;
	const argv = commit.argv.map((word) => word.text);
	for (let i = 1; i < argv.length; i++) {
		const token = argv[i] ?? "";
		if (!token.startsWith("-")) break;
		if (token === "-C" && argv[i + 1] !== undefined) {
			dir = resolve(dir, unquote(argv[i + 1] ?? ""));
			i++;
		} else if (token.startsWith("-C")) {
			dir = resolve(dir, unquote(token.slice(2)));
		} else if (token === "-c") {
			i++;
		}
	}
	return dir;
}

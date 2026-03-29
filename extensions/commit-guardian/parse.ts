/**
 * Commit command parsing: re-exports shared utilities from
 * lib/guardian/shell and adds the commit-guardian-specific
 * detect function.
 */

export {
	buildCommitHeredoc,
	extractCommitFlags,
	extractMessage,
	splitAtCommit,
} from "../../lib/internal/guardian/shell.js";

/**
 * Detect whether a bash command contains a git commit with
 * a message body.
 */
export function isCommitCommand(command: string): boolean {
	return /\bgit\s+commit\b/.test(command);
}

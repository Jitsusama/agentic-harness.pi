/**
 * Commit command parsing: re-exports shared utilities from
 * lib/guardian/shell and adds the commit-guardian-specific
 * detect function.
 */

import { isGitCommitCommand } from "../../lib/internal/guardian/shell.js";

export { extractMessage } from "../../lib/internal/guardian/shell.js";

/**
 * Detect whether a bash command contains a git commit. Routes
 * through the command model so a commit reached past leading git
 * global options (git -C dir commit) is still detected.
 */
export function isCommitCommand(command: string): boolean {
	return isGitCommitCommand(command);
}

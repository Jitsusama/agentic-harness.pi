/**
 * Commit command parsing: re-exports shared utilities from
 * lib/guardian/shell and adds the commit-guardian-specific
 * detect function.
 */

import { isGitCommitCommand } from "@jitsusama/agentic-harness.core/guardian/commit-shell";

export { extractMessage } from "@jitsusama/agentic-harness.core/guardian/commit-shell";

/**
 * Detect whether a bash command contains a git commit. Routes
 * through the command model so a commit reached past leading git
 * global options (git -C dir commit) is still detected.
 */
export function isCommitCommand(command: string): boolean {
	return isGitCommitCommand(command);
}

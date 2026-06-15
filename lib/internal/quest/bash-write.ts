/**
 * Advisory classification of a bash command for the quest phase
 * gate. The command is reduced to its executable skeleton first
 * (heredoc bodies and quoted data removed) so a mutating verb that
 * appears only as a literal argument, or inside a heredoc body,
 * does not trip the gate. This is a nudge toward the right stage,
 * not a security boundary.
 */

import { stripHeredocBodies, stripShellData } from "../../shell/index.js";

/** What kind of write, if any, a bash command performs. */
export type BashWriteKind = "git-mutating" | "bash-write" | "read-only";

/** Git subcommands that change repository or working-tree state. */
const GIT_MUTATING =
	/\bgit(?:\s+(?:-c\s+\S+|-C\s+\S+|--git-dir=\S+|--work-tree=\S+|--no-pager))*\s+(add|commit|push|pull|merge|rebase|reset|checkout|stash|cherry-pick|revert|tag|switch|restore|am|format-patch)\b/i;

/** Shell patterns that write to the filesystem via redirection or in-place edit. */
const BASH_WRITE_PATTERNS = [
	/(^|\s|[;&|`])cat\s+[^|]*>>?\s/, // cat > foo, cat >> foo
	/(^|\s|[;&|`])tee\s+(?:-[a-z]+\s+)*\S/, // tee foo, tee -a foo
	/(^|\s|[;&|`])sed\s+(?:-[a-z]+\s+)*-i\b/, // sed -i
	/(^|\s|[;&|`])gsed\s+(?:-[a-z]+\s+)*-i\b/, // homebrew sed
	/(^|\s|[;&|`])perl\s+(?:-[a-z]+\s+)*-i\b/, // perl -i
	/(^|\s|[;&|`])printf\s+.+>>?\s/, // printf > foo
	/(^|\s|[;&|`])echo\s+.+>>?\s/, // echo > foo
];

/**
 * Classify a bash command after stripping non-executable content,
 * so quoted literals and heredoc bodies cannot raise a false
 * positive.
 */
export function classifyBashWrite(command: string): BashWriteKind {
	const skeleton = stripShellData(stripHeredocBodies(command));
	if (GIT_MUTATING.test(skeleton)) return "git-mutating";
	if (BASH_WRITE_PATTERNS.some((rx) => rx.test(skeleton))) return "bash-write";
	return "read-only";
}

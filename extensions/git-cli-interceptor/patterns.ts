/**
 * Detects bash commands that violate the git-cli-convention
 * skill's "one concern per bash call" rule.
 *
 * A guardable command is one that a guardian or interceptor
 * needs to process independently (git commit, gh pr/issue
 * create/edit). Two guardable commands in one bash call means
 * one guardian's rewrite could drop the other command.
 *
 * The git add + git commit pattern is explicitly allowed
 * because git add is a staging prefix, not a guardable target.
 */

import { stripHeredocBodies } from "../../lib/internal/guardian/shell.js";

/** Commands that guardians intercept and may rewrite. */
const GUARDABLE_PATTERNS: RegExp[] = [
	/\bgit\s+commit\b/,
	/\bgh\s+pr\s+(?:create|edit)\b/,
	/\bgh\s+issue\s+(?:create|edit)\b/,
];

/**
 * Git state changes that shouldn't be chained with guardable
 * commands. These alter repo state in ways the subsequent
 * command depends on, and a guardian rewrite could drop them.
 */
const STATE_CHANGE_PATTERNS: RegExp[] = [
	/\bgit\s+push\b/,
	/\bgit\s+checkout\b/,
	/\bgit\s+switch\b/,
	/\bgit\s+pull\b/,
	/\bgit\s+merge\b/,
	/\bgit\s+rebase\b/,
	/\bgit\s+reset\b/,
	/\bgit\s+stash\b/,
	/\bgit\s+fetch\b/,
];

/** Shell separators that divide independent commands. */
const SEPARATOR = /\s*(?:&&|;|\n)\s*/;

/**
 * Block `git commit --amend` unconditionally. Amends
 * rewrite history and are almost never the right choice
 * when the agent can just make a new commit.
 */
export function detectAmendViolation(command: string): string | null {
	const stripped = stripHeredocBodies(command);
	if (/\bgit\s+commit\b/.test(stripped) && /--amend\b/.test(stripped)) {
		return (
			"Blocked: --amend is not allowed. Make a new commit " +
			"instead.\n\n" +
			"Amending rewrites history and is almost never necessary. " +
			"A new commit is cleaner and preserves the work trail. " +
			"Read the git-commit-convention skill for guidance."
		);
	}
	return null;
}

/**
 * Check whether a bash command chains multiple concerns that
 * should be separate calls. Returns a block reason or null
 * if the command is fine.
 */
export function detectCompoundViolation(command: string): string | null {
	const stripped = stripHeredocBodies(command);
	const segments = stripped.split(SEPARATOR).filter(Boolean);
	if (segments.length < 2) return null;

	let guardableCount = 0;
	let stateChangeCount = 0;

	for (const segment of segments) {
		const trimmed = segment.trim();

		if (GUARDABLE_PATTERNS.some((p) => p.test(trimmed))) {
			guardableCount++;
			continue;
		}

		if (STATE_CHANGE_PATTERNS.some((p) => p.test(trimmed))) {
			stateChangeCount++;
		}
	}

	if (guardableCount > 1) {
		return (
			"Blocked: multiple guardable commands in one bash call. " +
			"Each git commit, gh pr create/edit and gh issue create/edit " +
			"must be its own bash call so guardians can review them " +
			"independently.\n\n" +
			"Read the git-cli-convention skill for the correct pattern, " +
			"then retry with separate bash calls."
		);
	}

	if (guardableCount > 0 && stateChangeCount > 0) {
		return (
			"Blocked: git state change chained with a guardable command. " +
			"Commands like git push, git checkout and git pull must be " +
			"separate bash calls from git commit, gh pr create/edit and " +
			"gh issue create/edit.\n\n" +
			"Read the git-cli-convention skill for the correct pattern, " +
			"then retry with separate bash calls."
		);
	}

	return null;
}

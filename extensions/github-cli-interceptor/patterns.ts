/**
 * Detects gh pr/issue commands that violate the
 * github-cli-convention skill's formatting rules.
 *
 * The convention requires heredoc syntax (--body-file -)
 * for body content and metadata assignment in separate
 * commands after creation.
 */

/** Matches gh pr or issue create/edit commands. */
const GH_ENTITY_COMMAND = /\bgh\s+(?:pr|issue)\s+(?:create|edit)\b/;

/** Matches the --body flag (not --body-file). */
const INLINE_BODY = /--body\s+(?:"[^"]*"|'[^']*'|\S+)/;

/** Matches the --body-file flag (the correct form). */
const BODY_FILE = /--body-file\b/;

/**
 * Metadata flags that should be in separate edit commands,
 * not packed into create.
 */
const METADATA_FLAGS =
	/--(?:add-)?(?:label|assignee|reviewer|project)\b|--milestone\b/;

/** Matches a gh create (not edit) command. */
const GH_CREATE = /\bgh\s+(?:pr|issue)\s+create\b/;

/**
 * Check whether a gh command uses --body instead of
 * --body-file with heredoc. Returns a block reason or
 * null if the command is fine.
 */
export function detectInlineBody(command: string): string | null {
	if (!GH_ENTITY_COMMAND.test(command)) return null;
	if (!INLINE_BODY.test(command)) return null;
	if (BODY_FILE.test(command)) return null;

	return (
		"Blocked: gh pr/issue command uses --body instead of " +
		"--body-file with heredoc. The --body flag has quoting " +
		"issues with markdown content.\n\n" +
		"Read the github-cli-convention skill for the heredoc " +
		"pattern, then retry."
	);
}

/**
 * Check whether a gh create command packs metadata flags
 * that should be in separate edit commands. Returns a block
 * reason or null if the command is fine.
 */
export function detectPackedMetadata(command: string): string | null {
	if (!GH_CREATE.test(command)) return null;
	if (!METADATA_FLAGS.test(command)) return null;

	return (
		"Blocked: gh create command includes metadata flags " +
		"(labels, assignees, reviewers, milestones, projects). " +
		"Assign metadata in separate gh edit commands after " +
		"creation.\n\n" +
		"Read the github-cli-convention skill for the correct " +
		"pattern, then retry."
	);
}

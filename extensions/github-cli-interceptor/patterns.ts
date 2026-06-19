/**
 * Detects gh pr/issue commands that violate the
 * github-cli-convention skill's formatting rules.
 *
 * The convention requires heredoc syntax (--body-file -)
 * with a quoted delimiter for body content, and metadata
 * assignment in separate commands after creation.
 */

import {
	findFlag,
	type SimpleCommand,
	tokenize,
} from "../../lib/command/index.js";
import { GH_BODY_SPEC } from "../../lib/internal/github/command-spec.js";
import {
	extractBodyFilePath,
	hasUnquotedHeredoc,
} from "../../lib/shell/parse.js";

/** Matches gh pr or issue create/edit commands. */
const GH_ENTITY_COMMAND = /\bgh\s+(?:pr|issue)\s+(?:create|edit)\b/;

/** Matches --body-file - (stdin). */
const BODY_FILE_STDIN = /--body-file\s+-(?:\s|$)/;

/** Matches a heredoc operator. */
const HEREDOC = /<<-?\s*['"]?\w/;

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
	const gh = findGhEntityCommand(command);
	if (!gh) return null;
	// The body-file heredoc form is the correct one; only an inline
	// body (--body or its short -b) is the violation.
	if (gh.heredoc) return null;
	if (findFlag(gh, GH_BODY_SPEC, "body-file")) return null;
	if (!findFlag(gh, GH_BODY_SPEC, "body")) return null;

	return (
		"Blocked: gh pr/issue command uses an inline body (--body or " +
		"-b) instead of --body-file with a heredoc. An inline body has " +
		"quoting issues with markdown content.\n\n" +
		"Read the github-cli-convention skill for the heredoc " +
		"pattern, then retry."
	);
}

/** Find a gh pr/issue create or edit command in a bash command. */
function findGhEntityCommand(command: string): SimpleCommand | undefined {
	return tokenize(command).commands.find(
		(c) =>
			c.argv[0]?.text === "gh" &&
			(c.argv[1]?.text === "pr" || c.argv[1]?.text === "issue") &&
			(c.argv[2]?.text === "create" || c.argv[2]?.text === "edit"),
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

/**
 * Check whether a gh command uses --body-file with a file
 * path instead of stdin. The convention requires
 * `--body-file -` piped from a heredoc, never a file path.
 */
export function detectBodyFilePath(command: string): string | null {
	if (!GH_ENTITY_COMMAND.test(command)) return null;
	const path = extractBodyFilePath(command);
	if (!path) return null;

	return (
		"Blocked: --body-file points to a file path " +
		`(${path}) instead of stdin. Use \`--body-file -\` ` +
		"with a heredoc to pipe the body content.\n\n" +
		"Read the github-cli-convention skill for the heredoc " +
		"pattern, then retry."
	);
}

/**
 * Check whether a gh command uses --body-file - but has no
 * heredoc to feed it. Without a heredoc, the command hangs
 * waiting for stdin.
 *
 * Takes both the stripped command (for gh scoping and
 * --body-file detection) and the original (for heredoc
 * presence, since stripping removes the operator).
 */
export function detectMissingHeredoc(
	stripped: string,
	original: string,
): string | null {
	if (!GH_ENTITY_COMMAND.test(stripped)) return null;
	if (!BODY_FILE_STDIN.test(stripped)) return null;
	if (HEREDOC.test(original)) return null;

	return (
		"Blocked: --body-file - has no heredoc to provide the " +
		"body content. The command will hang waiting for stdin.\n\n" +
		"Add a heredoc after the command: " +
		"`--body-file - <<'EOF'\n...body...\nEOF`\n\n" +
		"Read the github-cli-convention skill for the correct " +
		"pattern, then retry."
	);
}

/**
 * Check whether a gh command uses a heredoc with an unquoted
 * delimiter. Unquoted delimiters allow shell variable expansion
 * (`$variable`, backticks, `$(command)`) which corrupts body
 * content.
 *
 * Takes both the stripped command (for gh scoping) and the
 * original (for heredoc operator validation, which stripping
 * would remove).
 */
export function detectUnsafeHeredoc(
	stripped: string,
	original: string,
): string | null {
	if (!GH_ENTITY_COMMAND.test(stripped)) return null;
	if (!hasUnquotedHeredoc(original)) return null;

	return (
		"Blocked: heredoc uses an unquoted delimiter (e.g. " +
		"`<<EOF`), which allows shell variable expansion. " +
		"Use a quoted delimiter (`<<'EOF'`) to prevent " +
		"`$variable` and backtick expansion from corrupting " +
		"the body content.\n\n" +
		"Read the github-cli-convention skill for the correct " +
		"pattern, then retry."
	);
}

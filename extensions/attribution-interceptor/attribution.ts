/**
 * Attribution injection: appends AI co-authorship metadata to
 * git commit messages, PR bodies, and issue bodies.
 *
 * Each function detects the relevant command, checks for existing
 * attribution (idempotency), and returns the rewritten command
 * or null if no injection is needed.
 */

import {
	type GhFooterInsertion,
	insertGhBodyFooter,
} from "../../lib/internal/github/attribution-edit.js";
import { readCommitFile } from "../../lib/internal/guardian/commit-file.js";
import {
	appendTrailerIfAbsent,
	coAuthorTrailer,
	formatModelName,
} from "../../lib/internal/guardian/commit-trailer.js";
import {
	buildCommitHeredoc,
	extractCommitFlags,
	extractMessage,
	splitAtCommit,
} from "../../lib/internal/guardian/shell.js";
import { stripHeredocBodies, stripShellData } from "../../lib/shell/parse.js";

/** Regex to detect existing attribution (case-insensitive). */
const ATTRIBUTION_PATTERN = /co-authored-by[:\s]+ai/i;

/** Build the markdown footer for PRs and issues. */
function ghFooter(modelId: string | null): string {
	const modelPart = modelId ? ` (${formatModelName(modelId)})` : "";
	// We need the double newline before --- so GitHub doesn't
	// treat the preceding paragraph as a setext h2 heading.
	return `\n\n---\n*Co-Authored-By AI${modelPart} via [Pi](https://github.com/badlogic/pi-mono)*`;
}

/**
 * Inject a Co-Authored-By trailer into a git commit command.
 * Returns the rewritten command or null if not applicable.
 */
export function injectCommitAttribution(
	command: string,
	modelId: string | null,
): string | null {
	const stripped = stripShellData(stripHeredocBodies(command));
	if (!/\bgit\s+commit\b/.test(stripped)) return null;

	// Resolve a `git commit -F <file>` by reading the file, so a
	// file-based message is translated to the canonical heredoc
	// form and carries attribution like any other commit.
	const message = extractMessage(command, readCommitFile);
	if (!message) return null;

	const attributed = appendTrailerIfAbsent(message, coAuthorTrailer(modelId));
	if (attributed === null) return null;

	const { prefix, commitPart } = splitAtCommit(command);
	const flags = extractCommitFlags(commitPart);

	const heredoc = buildCommitHeredoc(attributed, flags);
	return prefix ? `${prefix} && ${heredoc}` : heredoc;
}

/**
 * Attribute a gh pr or gh issue command by splicing the footer into
 * its body in place, so the working directory, environment and
 * every other flag survive untouched. Returns a rewritten, blocked
 * or skip verdict; the caller fails closed on a blocked command so
 * a gh entity command in an unsupported shape never runs
 * un-attributed.
 */
export function attributeGh(
	command: string,
	entity: "pr" | "issue",
	modelId: string | null,
): GhFooterInsertion {
	return insertGhBodyFooter(command, entity, ghFooter(modelId), (body) =>
		ATTRIBUTION_PATTERN.test(body),
	);
}

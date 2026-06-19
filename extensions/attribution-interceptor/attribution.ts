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
	buildCommitHeredoc,
	extractCommitFlags,
	extractMessage,
	splitAtCommit,
} from "../../lib/internal/guardian/shell.js";
import { stripHeredocBodies, stripShellData } from "../../lib/shell/parse.js";

/** Regex to detect existing attribution (case-insensitive). */
const ATTRIBUTION_PATTERN = /co-authored-by[:\s]+ai/i;

/**
 * Format the model identifier for display.
 *
 * Strips date suffixes (e.g. "claude-sonnet-4-20250514" → "Claude Sonnet 4")
 * and converts hyphens to spaces with title casing. Consecutive digit
 * segments are joined with dots to form version numbers
 * (e.g. "claude-opus-4-6" → "Claude Opus 4.6").
 */
function formatModelName(modelId: string): string {
	// We strip the trailing date suffix (8+ digits, optionally preceded by a hyphen).
	const stripped = modelId.replace(/-?\d{8,}$/, "");
	const parts = stripped.split("-");

	const result: string[] = [];
	for (const part of parts) {
		const isDigit = /^\d+$/.test(part);
		const prevIsDigit =
			result.length > 0 && /^\d/.test(result[result.length - 1]);

		if (isDigit && prevIsDigit) {
			// We join consecutive digit segments with a dot to form a version number.
			result[result.length - 1] += `.${part}`;
		} else {
			result.push(part.charAt(0).toUpperCase() + part.slice(1));
		}
	}
	return result.join(" ");
}

/** Build the git trailer line for commits. */
function commitTrailer(modelId: string | null): string {
	const modelPart = modelId
		? ` (${formatModelName(modelId)} via Pi)`
		: " via Pi";
	return `Co-Authored-By: AI${modelPart} <noreply@pi.dev>`;
}

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
	if (ATTRIBUTION_PATTERN.test(message)) return null;

	const { prefix, commitPart } = splitAtCommit(command);
	const flags = extractCommitFlags(commitPart);

	// Git trailers need a blank line before them, so we add one
	// if the message doesn't already end with a newline.
	const separator = message.endsWith("\n") ? "\n" : "\n\n";
	const attributed = `${message}${separator}${commitTrailer(modelId)}`;

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

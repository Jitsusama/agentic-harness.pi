/**
 * Attribution injection: appends AI co-authorship metadata to
 * git commit messages, PR bodies, and issue bodies.
 *
 * Each function detects the relevant command, checks for existing
 * attribution (idempotency), and returns the rewritten command
 * or null if no injection is needed.
 */

import {
	isGhCommand,
	parseIssueCommand,
	parsePrCommand,
	rebuildGhCommand,
} from "../../lib/internal/github/cli.js";
import {
	buildCommitHeredoc,
	extractCommitFlags,
	extractMessage,
	splitAtCommit,
} from "../../lib/internal/guardian/shell.js";

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
	if (!/\bgit\s+commit\b/.test(command)) return null;

	const message = extractMessage(command);
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
 * Inject a Co-Authored-By footer into a gh pr or gh issue command.
 * Returns the rewritten command or null if not applicable.
 */
export function injectGhAttribution(
	command: string,
	entity: "pr" | "issue",
	modelId: string | null,
): string | null {
	if (!isGhCommand(command, entity)) return null;

	if (entity === "pr") {
		const parsed = parsePrCommand(command);
		if (!parsed?.body) return null;
		if (ATTRIBUTION_PATTERN.test(parsed.body)) return null;

		const attributed = parsed.body + ghFooter(modelId);
		return rebuildGhCommand({
			entity: "pr",
			action: parsed.action,
			entityNumber: parsed.prNumber,
			prefix: parsed.prefix,
			extraFlags: parsed.extraFlags,
			title: parsed.title,
			body: attributed,
			heredocDelim: "__PR_BODY__",
		});
	}

	const parsed = parseIssueCommand(command);
	if (!parsed?.body) return null;
	if (ATTRIBUTION_PATTERN.test(parsed.body)) return null;

	const attributed = parsed.body + ghFooter(modelId);
	return rebuildGhCommand({
		entity: "issue",
		action: parsed.action,
		entityNumber: parsed.issueNumber,
		prefix: parsed.prefix,
		extraFlags: parsed.extraFlags,
		title: parsed.title,
		body: attributed,
		heredocDelim: "__ISSUE_BODY__",
	});
}

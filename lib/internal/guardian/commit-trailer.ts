/**
 * Commit attribution trailer: formatting the Co-Authored-By line
 * and appending it to a commit message idempotently.
 *
 * Shared so the attribution interceptor and the prepare-commit-msg
 * hook produce an identical trailer rather than drifting apart.
 */

/** Regex to detect existing AI attribution (case-insensitive). */
const ATTRIBUTION_PATTERN = /co-authored-by[:\s]+ai/i;

/**
 * Format the model identifier for display. Strips a trailing date
 * suffix, title-cases hyphen segments and joins consecutive digit
 * segments into a version number (claude-opus-4-6 -> Claude Opus 4.6).
 */
export function formatModelName(modelId: string): string {
	const stripped = modelId.replace(/-?\d{8,}$/, "");
	const parts = stripped.split("-");

	const result: string[] = [];
	for (const part of parts) {
		const isDigit = /^\d+$/.test(part);
		const prevIsDigit =
			result.length > 0 && /^\d/.test(result[result.length - 1]);
		if (isDigit && prevIsDigit) {
			result[result.length - 1] += `.${part}`;
		} else {
			result.push(part.charAt(0).toUpperCase() + part.slice(1));
		}
	}
	return result.join(" ");
}

/** Build the Co-Authored-By trailer line for a commit. */
export function coAuthorTrailer(modelId: string | null): string {
	const modelPart = modelId
		? ` (${formatModelName(modelId)} via Pi)`
		: " via Pi";
	return `Co-Authored-By: AI${modelPart} <noreply@pi.dev>`;
}

/**
 * Append the trailer to a commit message, after a blank line, when
 * the message is not already attributed. Returns null when it
 * already carries an AI co-author, so the append is idempotent.
 */
export function appendTrailerIfAbsent(
	message: string,
	trailer: string,
): string | null {
	if (ATTRIBUTION_PATTERN.test(message)) return null;
	const separator = message.endsWith("\n") ? "\n" : "\n\n";
	return `${message}${separator}${trailer}`;
}

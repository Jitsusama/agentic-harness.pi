/**
 * Converts a redirect note and its surrounding context into
 * feedback strings for guardians and confirmation gates.
 */

/**
 * Format a redirect as a human-readable reason string.
 * Includes the user's note and the original context.
 */
export function formatRedirectReason(note: string, context: string): string {
	return [
		"User wants a different approach.",
		"",
		`Feedback: ${note}`,
		"",
		context,
		"",
		"Adjust based on the feedback and try again.",
	].join("\n");
}

/**
 * Format a redirect as a guardian block result.
 * Guardians return this directly from review().
 */
export function formatRedirectBlock(
	note: string,
	context: string,
): { block: true; reason: string } {
	return { block: true, reason: formatRedirectReason(note, context) };
}

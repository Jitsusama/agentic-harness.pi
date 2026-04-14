/**
 * Converts a redirect note and its surrounding context into
 * a human-readable feedback string.
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

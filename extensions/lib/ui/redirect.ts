/**
 * Converts a redirect note and its surrounding context into a
 * block reason that guardians and mode enforcement can use.
 */

/**
 * Format a redirect result into a block reason for tool_call handlers.
 * Includes the user's note and the original context.
 */
export function formatRedirect(
	note: string,
	context: string,
): { block: true; reason: string } {
	return {
		block: true,
		reason: [
			"User wants a different approach.",
			"",
			`Feedback: ${note}`,
			"",
			context,
			"",
			"Adjust based on the feedback and try again.",
		].join("\n"),
	};
}

/**
 * Steer result formatting — converts a steer note and context
 * into a block reason for guardians and mode enforcement.
 */

/**
 * Format a steer result into a block reason for tool_call handlers.
 * Includes the user's note and the original context.
 */
export function formatSteer(
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

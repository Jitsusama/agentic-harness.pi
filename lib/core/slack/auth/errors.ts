/**
 * Formatting a Slack auth failure for a tool result.
 *
 * Split out of the interactive auth orchestration (which needs a
 * host's UI to run the OAuth flow and stays adapter-local) because
 * this part is pure: an error in, a message out.
 */

/** Format an auth error for the tool result. */
export function formatAuthError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	if (message.includes("cancelled")) {
		return (
			"⚠️ Authentication required but was cancelled.\n\n" +
			"Run /slack-auth to authenticate with Slack."
		);
	}
	// Errors from describeError() already have a "Slack API error:" prefix.
	if (message.startsWith("Slack API error:")) return message;
	return `Slack API error: ${message}`;
}

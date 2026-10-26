/**
 * Formatting a Google Workspace auth failure for a tool result.
 *
 * Split out of the interactive auth orchestration (which needs a
 * host's UI to run the device/web flow and stays adapter-local)
 * because this part is pure: an error in, a message out. The
 * messages are exported too, since the adapter-local orchestration
 * throws them verbatim to reach this formatter.
 */

export const AUTH_MESSAGES = {
	cancelled:
		"⚠️ Authentication required but was cancelled.\n\n" +
		"Run /google-auth to authenticate with your Google account.",

	setupCancelled:
		"⚠️ OAuth credentials setup required but was cancelled.\n\n" +
		"Run /google-setup to configure Google Workspace access.",
};

/** Format an auth error for tool results. */
export function formatAuthError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);

	if (message.includes("cancelled")) {
		return AUTH_MESSAGES.cancelled;
	}

	if (message.includes("setup required")) {
		return AUTH_MESSAGES.setupCancelled;
	}

	return `Google Workspace API error: ${message}`;
}

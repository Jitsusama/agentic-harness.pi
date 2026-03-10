/**
 * Authentication flow orchestration.
 * Ensures user is authenticated before executing requests.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type { OAuth2Client } from "google-auth-library";
import type { OAuthAppCredentials } from "./auth/credentials.js";
import { handleGoogleAuthCommand } from "./auth-command.js";

/**
 * Authentication prompts and messages.
 */
const AUTH_MESSAGES = {
	required:
		"\n🔐 Authentication Required\n\n" +
		"You need to authenticate with your Google account before using Google Workspace features.\n" +
		"This is a one-time setup using device flow (works everywhere - SSH, containers, etc.).\n",

	prompt: "Would you like to authenticate now?",

	cancelled:
		"⚠️ Authentication required but was cancelled.\n\n" +
		"Run /google-auth to authenticate with your Google account.",

	setupCancelled:
		"⚠️ OAuth credentials setup required but was cancelled.\n\n" +
		"Run /google-setup to configure Google Workspace access.",
};

/**
 * Ensure user is authenticated with Google Workspace.
 *
 * Flow:
 * 1. Try to get existing auth client
 * 2. If not authenticated, prompt user
 * 3. Run device flow authentication
 * 4. Return authenticated client
 *
 * @param pi - Extension API
 * @param ctx - Extension context
 * @param account - Account name to authenticate
 * @param oauthConfig - OAuth app credentials
 * @param getAuthClient - Function to get authenticated OAuth client
 * @returns Authenticated OAuth2 client
 * @throws Error if authentication fails or is cancelled
 */
export async function ensureAuthenticated(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	account: string,
	oauthConfig: OAuthAppCredentials,
	getAuthClient: (
		ctx: ExtensionContext,
		account: string,
	) => Promise<OAuth2Client>,
): Promise<OAuth2Client> {
	try {
		// Try to get existing authenticated client
		return await getAuthClient(ctx, account);
	} catch (error) {
		// Check if this is an authentication error
		const message = error instanceof Error ? error.message : String(error);
		if (!message.includes("Not authenticated")) {
			throw error; // Some other error, re-throw
		}

		// Not authenticated - guide user through auth flow
		if (!ctx.hasUI) {
			throw new Error(
				"Not authenticated and no UI available for interactive authentication.",
			);
		}

		// Show authentication required message
		ctx.ui.notify(AUTH_MESSAGES.required, "info");

		// Confirm user wants to authenticate now
		const proceed = await ctx.ui.confirm(AUTH_MESSAGES.prompt);
		if (!proceed) {
			throw new Error(AUTH_MESSAGES.cancelled);
		}

		// Run authentication flow
		await handleGoogleAuthCommand(`--account ${account}`, ctx, pi, oauthConfig);

		// Get authenticated client (will throw if auth failed)
		return await getAuthClient(ctx, account);
	}
}

/**
 * Format error message for tool result.
 */
export function formatAuthError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);

	// Check for specific error types
	if (message.includes("cancelled")) {
		return AUTH_MESSAGES.cancelled;
	}

	if (message.includes("setup required")) {
		return AUTH_MESSAGES.setupCancelled;
	}

	// Generic error
	return `Google Workspace API error: ${message}`;
}

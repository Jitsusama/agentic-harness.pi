/**
 * Orchestrates the authentication flow, making sure the user
 * is authenticated before any requests go out.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { OAuth2Client } from "google-auth-library";
import { promptSingle } from "../lib/ui/panel.js";
import type { OAuthAppCredentials } from "./auth/credentials.js";
import { handleGoogleAuthCommand } from "./auth-command.js";

/**
 * Authentication prompts and messages.
 */
const AUTH_MESSAGES = {
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
 * @param ctx - Extension context
 * @param account - Account name to authenticate
 * @param oauthConfig - OAuth app credentials
 * @param getAuthClient - Function to get authenticated OAuth client
 * @returns Authenticated OAuth2 client
 * @throws Error if authentication fails or is cancelled
 */
export async function ensureAuthenticated(
	ctx: ExtensionContext,
	account: string,
	oauthConfig: OAuthAppCredentials,
	getAuthClient: (
		ctx: ExtensionContext,
		account: string,
		oauthConfig: OAuthAppCredentials,
	) => Promise<OAuth2Client>,
): Promise<OAuth2Client> {
	try {
		// We try to get an existing authenticated client.
		return await getAuthClient(ctx, account, oauthConfig);
	} catch (error) {
		// We check if this is an authentication error.
		const message = error instanceof Error ? error.message : String(error);
		if (!message.includes("Not authenticated")) {
			throw error; // Some other error, re-throw
		}

		// The user isn't authenticated, so we guide them through the auth flow.
		if (!ctx.hasUI) {
			throw new Error(
				"Not authenticated and no UI available for interactive authentication.",
			);
		}

		// We confirm the user wants to authenticate now.
		const result = await promptSingle(ctx, {
			content: (theme, _width) => [
				` ${theme.bold("🔐 Authentication Required")}`,
				"",
				" You need to authenticate with your Google account",
				" before using Google Workspace features.",
				"",
				" This is a one-time setup using device flow",
				" (works everywhere: SSH, containers, etc.).",
			],
			options: [
				{ label: "Authenticate now", value: "yes" },
				{ label: "Cancel", value: "no" },
			],
		});
		if (!result || result.type !== "option" || result.value !== "yes") {
			throw new Error(AUTH_MESSAGES.cancelled);
		}

		// We run the authentication flow.
		await handleGoogleAuthCommand(`--account ${account}`, ctx, oauthConfig);

		// We get the authenticated client (this will throw if auth failed).
		return await getAuthClient(ctx, account, oauthConfig);
	}
}

/**
 * Format error message for tool result.
 */
export function formatAuthError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);

	// We check for specific error types.
	if (message.includes("cancelled")) {
		return AUTH_MESSAGES.cancelled;
	}

	if (message.includes("setup required")) {
		return AUTH_MESSAGES.setupCancelled;
	}

	// Generic error
	return `Google Workspace API error: ${message}`;
}

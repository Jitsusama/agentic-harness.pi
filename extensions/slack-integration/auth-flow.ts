/**
 * Orchestrates Slack authentication, guiding the user through
 * the OAuth web redirect flow when no valid token exists.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { promptSingle, view } from "../lib/ui/panel.js";
import { SlackClient } from "./api/client.js";
import { openInBrowser } from "./auth/browser.js";
import {
	getToken,
	hasToken,
	type OAuthApp,
	storeToken,
} from "./auth/credentials.js";
import {
	buildAuthUrl,
	CALLBACK_PORT,
	exchangeCodeForToken,
} from "./auth/oauth.js";
import { waitForOAuthCallback } from "./auth/server.js";

/** Messages shown during the auth flow. */
const AUTH_MESSAGES = {
	cancelled:
		"⚠️ Authentication required but was cancelled.\n\n" +
		"Run /slack-auth to authenticate with Slack.",
	setupCancelled:
		"⚠️ OAuth credentials setup required but was cancelled.\n\n" +
		"Run /slack-setup to configure Slack app credentials.",
};

/**
 * Ensure the user is authenticated with Slack.
 *
 * Returns a SlackClient ready to make API calls. If no valid
 * token exists, prompts the user through the OAuth flow.
 */
export async function ensureAuthenticated(
	ctx: ExtensionContext,
	oauthApp: OAuthApp,
): Promise<SlackClient> {
	if (hasToken()) {
		const token = getToken();
		if (token) {
			const client = new SlackClient(token.accessToken);

			// Verify the token still works.
			try {
				await client.call("auth.test");
				return client;
			} catch {
				// Token expired or revoked, fall through to re-auth.
			}
		}
	}

	if (!ctx.hasUI) {
		throw new Error(
			"Not authenticated and no UI available for interactive authentication.",
		);
	}

	const result = await promptSingle(ctx, {
		content: (theme) => [
			` ${theme.bold("🔐 Slack Authentication Required")}`,
			"",
			" You need to authenticate with Slack before using",
			" Slack features. This opens your browser to authorize",
			" the app with your Slack workspace.",
		],
		options: [
			{ label: "Authenticate now", value: "yes" },
			{ label: "Cancel", value: "no" },
		],
	});

	if (!result || result.type !== "option" || result.value !== "yes") {
		throw new Error(AUTH_MESSAGES.cancelled);
	}

	return await runOAuthFlow(ctx, oauthApp);
}

/**
 * Run the Slack OAuth web redirect flow.
 *
 * Opens the browser to Slack's authorization page, starts a
 * local server to receive the callback, exchanges the code
 * for a token, verifies it, and stores it.
 */
async function runOAuthFlow(
	ctx: ExtensionContext,
	oauthApp: OAuthApp,
): Promise<SlackClient> {
	const state = generateState();
	const authUrl = buildAuthUrl(oauthApp, state);

	const dismiss = new AbortController();

	// Show a waiting panel while the user authorizes in their browser.
	view(ctx, {
		signal: dismiss.signal,
		content: (theme) => [
			` ${theme.bold("🌐 Slack Authorization")}`,
			"",
			" Your browser should open automatically.",
			" If it doesn't, visit this URL:",
			` ${theme.fg("accent", authUrl)}`,
			"",
			` ${theme.fg("dim", "Waiting for authorization…")}`,
		],
	});

	openInBrowser(authUrl);

	try {
		const callback = await waitForOAuthCallback(CALLBACK_PORT);

		if (callback.error) {
			throw new Error(`Slack OAuth error: ${callback.error}`);
		}

		if (!callback.code) {
			throw new Error("No authorization code received from Slack.");
		}

		if (callback.state !== state) {
			throw new Error(
				"OAuth state mismatch. The callback may have come from a different flow.",
			);
		}

		const token = await exchangeCodeForToken(oauthApp, callback.code);
		storeToken(token);

		// Verify the token works.
		const client = new SlackClient(token.accessToken);
		await client.call("auth.test");

		ctx.ui.notify(
			`✓ Authenticated with Slack${token.teamName ? ` (${token.teamName})` : ""}`,
			"info",
		);

		return client;
	} finally {
		dismiss.abort();
	}
}

/** Format an auth error for the tool result. */
export function formatAuthError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);

	if (message.includes("cancelled")) {
		return AUTH_MESSAGES.cancelled;
	}
	if (message.includes("setup required")) {
		return AUTH_MESSAGES.setupCancelled;
	}
	return `Slack API error: ${message}`;
}

/** Generate a random state parameter for CSRF protection. */
function generateState(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

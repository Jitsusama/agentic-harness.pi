/**
 * Orchestrates Slack authentication, bridging the setup wizard
 * and the OAuth web redirect flow.
 *
 * Two auth paths converge here:
 *   - Browser session: setup wizard handles everything, this
 *     module just creates the client from stored credentials.
 *   - OAuth: setup wizard stores the app credentials, this
 *     module runs the web redirect flow to get a user token.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { view } from "../lib/ui/panel.js";
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
import { ensureSetup } from "./setup-wizard.js";

/**
 * Ensure the user is authenticated with Slack.
 *
 * Returns a SlackClient ready to make API calls. Runs the
 * setup wizard and/or OAuth flow as needed.
 */
export async function ensureAuthenticated(
	ctx: ExtensionContext,
	envConfig: OAuthApp,
): Promise<SlackClient> {
	const setup = await ensureSetup(ctx, envConfig);

	if (!setup) {
		throw new Error("Slack authentication setup was cancelled.");
	}

	// Browser session path: credentials are already stored.
	if (setup.mode === "session") {
		return clientFromStoredToken();
	}

	// OAuth path: may need to run the web redirect flow.
	if (hasToken()) {
		const token = getToken();
		if (token) {
			const client = new SlackClient(token.accessToken, token.cookie);
			try {
				await client.call("auth.test");
				return client;
			} catch {
				// Token invalid, run the OAuth flow.
			}
		}
	}

	return await runOAuthFlow(ctx, setup.app);
}

/** Create a client from the stored token. Throws if no token. */
function clientFromStoredToken(): SlackClient {
	const token = getToken();
	if (!token) {
		throw new Error("No stored Slack token found.");
	}
	return new SlackClient(token.accessToken, token.cookie);
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
			throw new Error("OAuth state mismatch.");
		}

		const token = await exchangeCodeForToken(oauthApp, callback.code);
		storeToken(token);

		const client = new SlackClient(token.accessToken, token.cookie);
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
		return (
			"⚠️ Authentication required but was cancelled.\n\n" +
			"Run /slack-auth to authenticate with Slack."
		);
	}
	return `Slack API error: ${message}`;
}

/** Generate a random state parameter for CSRF protection. */
function generateState(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * High-level Google authentication: one call to get a ready
 * OAuth2Client. Handles credential lookup, token refresh and
 * interactive auth flow.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Credentials, OAuth2Client } from "google-auth-library";
import { promptSingle } from "../../ui/index.js";
import {
	getCredentials,
	getDefaultAccount,
	listAccounts,
	type OAuthAppCredentials,
	saveAccount,
	storeCredentials,
} from "./credentials.js";
import { authenticateWithFallback } from "./dual-flow.js";
import {
	createOAuth2Client,
	extractTokens,
	refreshTokenIfNeeded,
	setCredentials,
} from "./oauth.js";
import { ensureOAuthApp } from "./setup-wizard.js";

const AUTH_MESSAGES = {
	cancelled:
		"⚠️ Authentication required but was cancelled.\n\n" +
		"Run /google-auth to authenticate with your Google account.",

	setupCancelled:
		"⚠️ OAuth credentials setup required but was cancelled.\n\n" +
		"Run /google-setup to configure Google Workspace access.",
};

/**
 * Ensure the user is authenticated with Google Workspace.
 *
 * Returns an OAuth2Client ready to make API calls. Runs the
 * setup wizard and/or device/web auth flow as needed.
 *
 * @param ctx - Extension context for interactive prompts
 * @param envConfig - OAuth credentials from environment variables (fallback)
 * @param account - Account name (defaults to the default account or "work")
 */
export async function ensureAuthenticated(
	ctx: ExtensionContext,
	envConfig: OAuthAppCredentials,
	account?: string,
): Promise<OAuth2Client> {
	// Ensure OAuth app credentials are configured.
	const oauthConfig = await ensureOAuthApp(ctx, envConfig);
	if (!oauthConfig) {
		throw new Error("OAuth credentials setup required but was cancelled.");
	}

	const accountName =
		account ?? getDefaultAccount()?.name ?? "work";

	// Try to build a client from stored credentials.
	const stored = getCredentials(accountName);
	if (stored) {
		const client = createOAuth2Client(oauthConfig);
		setCredentials(client, stored);

		const refreshed = await refreshTokenIfNeeded(client);
		if (refreshed) {
			storeCredentials(accountName, refreshed);
		}

		return client;
	}

	// No stored credentials — run the interactive auth flow.
	if (!ctx.hasUI) {
		throw new Error(
			"Not authenticated and no UI available for interactive authentication.",
		);
	}

	const result = await promptSingle(ctx, {
		content: (theme) => [
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

	const flowResult = await authenticateWithFallback(
		{ ...oauthConfig, redirectUri: "http://localhost:8765" },
		ctx,
	);

	const client = createOAuth2Client(oauthConfig);
	setCredentials(client, flowResult.credentials);
	const email = await extractEmailSafe(client);

	storeCredentials(accountName, flowResult.credentials);
	saveAccount({
		name: accountName,
		email,
		isDefault: listAccounts().length === 0,
	});

	const flowType =
		flowResult.flowUsed === "device" ? "device flow" : "web redirect";
	ctx.ui.notify(
		`✓ Authenticated as '${accountName}'${email ? ` (${email})` : ""} via ${flowType}`,
		"info",
	);

	return client;
}

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

/** Extract email from token info, returning undefined on failure. */
async function extractEmailSafe(
	client: OAuth2Client,
): Promise<string | undefined> {
	try {
		const tokenInfo = await client.getTokenInfo(
			client.credentials.access_token || "",
		);
		return tokenInfo.email;
	} catch {
		/* Token info fetch is non-critical. */
		return undefined;
	}
}

/**
 * High-level Google authentication: one call to get a ready
 * OAuth2Client. Handles credential lookup, token refresh and
 * interactive auth flow.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	AUTH_MESSAGES,
	getCredentials,
	getDefaultAccount,
	listAccounts,
	type OAuthAppCredentials,
	saveAccount,
	storeCredentials,
} from "@jitsusama/agentic-harness.core/google";
import {
	createOAuth2Client,
	refreshTokenIfNeeded,
	setCredentials,
} from "@jitsusama/agentic-harness.core/google/auth/oauth";
import type { OAuth2Client } from "google-auth-library";
import { promptSingle } from "../../ui/index.js";
import { authenticateWithFallback } from "./dual-flow.js";
import { ensureOAuthApp } from "./setup-wizard.js";

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

	const accountName = account ?? getDefaultAccount()?.name ?? "work";

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

	// No stored credentials, so run the interactive auth flow.
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
	if (result?.type !== "option" || result.value !== "yes") {
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

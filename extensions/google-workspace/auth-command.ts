/**
 * Google Workspace authentication command handler.
 * Uses OAuth 2.0 Device Flow for universal compatibility.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { OAuth2Client } from "google-auth-library";
import {
	listAccounts,
	saveAccount,
	setDefaultAccount,
	storeCredentials,
} from "./auth/credentials.js";

import { authenticateWithFallback } from "./auth/dual-flow.js";
import { createOAuth2Client, setCredentials } from "./auth/oauth.js";

interface OAuthConfig {
	clientId: string;
	clientSecret: string;
	redirectUri?: string;
}

/**
 * Handle /google-auth command using OAuth Device Flow.
 */
export async function handleGoogleAuthCommand(
	args: string | undefined,
	ctx: ExtensionContext,
	oauthConfig: OAuthConfig,
): Promise<void> {
	const parts = (args || "").trim().split(/\s+/);
	const flags = parseFlags(parts);

	// List accounts
	if (flags.list) {
		const accounts = listAccounts();
		if (accounts.length === 0) {
			ctx.ui.notify("No accounts configured.", "info");
			return;
		}
		for (const acc of accounts) {
			const marker = acc.isDefault ? " (default)" : "";
			const email = acc.email ? ` - ${acc.email}` : "";
			ctx.ui.notify(`${acc.name}${email}${marker}`, "info");
		}
		return;
	}

	// Set default account
	if (flags.default) {
		setDefaultAccount(flags.default);
		ctx.ui.notify(`Default account set to: ${flags.default}`, "success");
		return;
	}

	// Authenticate with device flow
	const accountName = flags.account || "work";

	if (!ctx.hasUI) {
		ctx.ui.notify("Authentication requires UI.", "error");
		return;
	}

	try {
		// Validate OAuth config
		if (!oauthConfig.clientId || !oauthConfig.clientSecret) {
			ctx.ui.notify(
				"OAuth credentials not configured.\n\n" +
					"Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET environment variables.\n" +
					"See extensions/google-workspace/README.md for setup instructions.",
				"error",
			);
			return;
		}

		ctx.ui.notify("Initiating Google Workspace authentication...", "info");

		// Attempt authentication with automatic fallback
		const abortController = new AbortController();
		const cancelHandler = () => {
			abortController.abort();
		};
		process.on("SIGINT", cancelHandler);

		try {
			const result = await authenticateWithFallback(
				{
					...oauthConfig,
					redirectUri: "http://localhost:8765",
				},
				ctx,
				abortController.signal,
			);

			// Create OAuth client and set credentials
			const client = createOAuth2Client(oauthConfig);
			setCredentials(client, result.credentials);

			// Extract email from token
			const email = await extractEmailFromToken(client);

			// Store credentials
			storeCredentials(accountName, result.credentials);

			// Save account info
			saveAccount({
				name: accountName,
				email,
				isDefault: listAccounts().length === 0,
			});

			const flowType =
				result.flowUsed === "device" ? "device flow" : "web redirect";
			ctx.ui.notify(
				`✓ Authenticated as account '${accountName}'${email ? ` (${email})` : ""} using ${flowType}`,
				"success",
			);
		} finally {
			process.off("SIGINT", cancelHandler);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);

		// User-friendly error messages
		if (message.includes("cancelled") || message.includes("aborted")) {
			ctx.ui.notify("Authentication cancelled.", "warn");
		} else if (message.includes("expired")) {
			ctx.ui.notify(
				"Authorization code expired. Please run /google-auth again.",
				"error",
			);
		} else if (message.includes("denied")) {
			ctx.ui.notify("Authorization denied by user.", "error");
		} else {
			ctx.ui.notify(`Authentication failed: ${message}`, "error");
		}
	}
}

/**
 * Extract email address from OAuth2 token.
 */
async function extractEmailFromToken(
	client: OAuth2Client,
): Promise<string | undefined> {
	try {
		const tokenInfo = await client.getTokenInfo(
			client.credentials.access_token || "",
		);
		return tokenInfo.email;
	} catch {
		// Token info fetch failed - non-critical, return undefined
		return undefined;
	}
}

/**
 * Parse command flags.
 */
function parseFlags(parts: string[]): {
	list?: boolean;
	account?: string;
	default?: string;
} {
	const flags: { list?: boolean; account?: string; default?: string } = {};

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		if (part === "--list") {
			flags.list = true;
		} else if (part === "--account" && i + 1 < parts.length) {
			flags.account = parts[i + 1];
			i++;
		} else if (part === "--default" && i + 1 < parts.length) {
			flags.default = parts[i + 1];
			i++;
		}
	}

	return flags;
}

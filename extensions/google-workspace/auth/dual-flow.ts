/**
 * Dual OAuth flow support - tries device flow first, falls back to web redirect.
 * This allows both "TVs and Limited Input devices" and "Desktop app" credentials to work.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Credentials } from "google-auth-library";
import type { OAuth2Config } from "./oauth.js";
import { initiateDeviceFlow, pollForDeviceAuthorization } from "./oauth.js";
import { waitForOAuthCallback } from "./server.js";

/**
 * Result of OAuth flow.
 */
export interface OAuthFlowResult {
	credentials: Credentials;
	flowUsed: "device" | "web";
}

/**
 * Attempt authentication using device flow first, fall back to web redirect.
 */
export async function authenticateWithFallback(
	config: OAuth2Config & { redirectUri?: string },
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<OAuthFlowResult> {
	// Try device flow first (works everywhere)
	try {
		const deviceFlow = await initiateDeviceFlow(config);

		ctx.ui.notify(
			`\n📱 Google Workspace Authentication (Device Flow)\n\n` +
				`Visit this URL in any browser:\n` +
				`  ${deviceFlow.verification_url}\n\n` +
				`Enter this code:\n` +
				`  ${deviceFlow.user_code}\n\n` +
				`Waiting for authorization... ⏳`,
			"info",
		);

		const credentials = await pollForDeviceAuthorization(
			config,
			deviceFlow.device_code,
			deviceFlow.interval,
			signal,
		);

		return { credentials, flowUsed: "device" };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);

		// If device flow failed due to invalid client type, fall back to web redirect
		if (
			message.includes("invalid_client") ||
			message.includes("Invalid OAuth client type")
		) {
			ctx.ui.notify(
				"\nℹ️  Device flow not supported by your OAuth credentials.\n" +
					"Falling back to web redirect flow (requires localhost)...\n",
				"info",
			);

			return await authenticateWithWebRedirect(config, ctx);
		}

		// Other errors, re-throw
		throw error;
	}
}

/**
 * Authenticate using web redirect flow (for Desktop app credentials).
 */
async function authenticateWithWebRedirect(
	config: OAuth2Config & { redirectUri?: string },
	ctx: ExtensionContext,
): Promise<OAuthFlowResult> {
	const { OAuth2Client } = await import("google-auth-library");

	const redirectUri = config.redirectUri || "http://localhost:8765";
	const client = new OAuth2Client(
		config.clientId,
		config.clientSecret,
		redirectUri,
	);

	const authUrl = client.generateAuthUrl({
		access_type: "offline",
		scope: [
			"https://www.googleapis.com/auth/gmail.modify",
			"https://www.googleapis.com/auth/calendar",
			"https://www.googleapis.com/auth/drive.readonly",
			"https://www.googleapis.com/auth/documents.readonly",
			"https://www.googleapis.com/auth/spreadsheets.readonly",
			"https://www.googleapis.com/auth/presentations.readonly",
		],
		prompt: "consent",
	});

	ctx.ui.notify(
		`\n🌐 Google Workspace Authentication (Web Flow)\n\n` +
			`Visit this URL:\n` +
			`  ${authUrl}\n\n` +
			`Waiting for callback on ${redirectUri}...\n`,
		"info",
	);

	const port = parseInt(redirectUri.split(":")[2] || "8765", 10);
	const result = await waitForOAuthCallback(port);

	if (result.error) {
		throw new Error(`OAuth error: ${result.error}`);
	}

	if (!result.code) {
		throw new Error("No authorization code received.");
	}

	const { tokens } = await client.getToken(result.code);
	client.setCredentials(tokens);

	return { credentials: tokens, flowUsed: "web" };
}

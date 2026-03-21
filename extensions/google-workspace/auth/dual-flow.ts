/**
 * Dual OAuth flow: tries device flow first, falls back to web redirect.
 * Supports both "TVs and Limited Input devices" and "Desktop app" credentials.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Credentials } from "google-auth-library";
import { view } from "../../lib/ui/panel.js";
import { openInBrowser } from "./browser.js";
import type { OAuth2Config } from "./oauth.js";
import {
	initiateDeviceFlow,
	pollForDeviceAuthorization,
	SCOPES,
} from "./oauth.js";
import { waitForOAuthCallback } from "./server.js";

/** Result of an OAuth flow. */
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
	try {
		const deviceFlow = await initiateDeviceFlow(config);
		const dismiss = new AbortController();

		// Show device code: dismissed when auth completes or user presses Escape
		view(ctx, {
			signal: dismiss.signal,
			content: (theme) => [
				` ${theme.bold("📱 Device Flow Authentication")}`,
				"",
				" Visit this URL in any browser:",
				` ${theme.fg("accent", deviceFlow.verification_url)}`,
				"",
				" Enter this code:",
				` ${theme.fg("accent", theme.bold(deviceFlow.user_code))}`,
				"",
				` ${theme.fg("dim", "Waiting for authorization…")}`,
			],
		});

		openInBrowser(deviceFlow.verification_url);

		try {
			const credentials = await pollForDeviceAuthorization(
				config,
				deviceFlow.device_code,
				deviceFlow.interval,
				signal,
			);
			return { credentials, flowUsed: "device" };
		} finally {
			dismiss.abort();
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);

		if (
			message.includes("invalid_client") ||
			message.includes("Invalid OAuth client type")
		) {
			return await authenticateWithWebRedirect(config, ctx);
		}

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
		scope: SCOPES,
		prompt: "consent",
	});

	const dismiss = new AbortController();

	// Show waiting panel: dismissed when callback arrives or user presses Escape
	view(ctx, {
		signal: dismiss.signal,
		content: (theme) => [
			` ${theme.bold("🌐 Web Flow Authentication")}`,
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
		const port = Number.parseInt(redirectUri.split(":")[2] || "8765", 10);
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
	} finally {
		dismiss.abort();
	}
}

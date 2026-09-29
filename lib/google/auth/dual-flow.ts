/**
 * Dual OAuth flow: tries device flow first, falls back to web redirect.
 * Supports both "TVs and Limited Input devices" and "Desktop app" credentials.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { AUTH_MESSAGES } from "@jitsusama/agentic-harness.core/google";
import { openInBrowser } from "@jitsusama/agentic-harness.core/google/auth/browser";
import type { OAuth2Config } from "@jitsusama/agentic-harness.core/google/auth/oauth";
import {
	initiateDeviceFlow,
	pollForDeviceAuthorization,
	SCOPES,
} from "@jitsusama/agentic-harness.core/google/auth/oauth";
import { waitForOAuthCallback } from "@jitsusama/agentic-harness.core/google/auth/server";
import type { Credentials } from "google-auth-library";
import { viewWhile } from "../../ui/index.ts";

/** Result of an OAuth flow. */
export interface OAuthFlowResult {
	credentials: Credentials;
	flowUsed: "device" | "web";
}

/**
 * Attempt authentication using device flow first, fall back to web redirect.
 * Closing the waiting panel, or the signal firing, cancels the login.
 */
export async function authenticateWithFallback(
	config: OAuth2Config & { redirectUri?: string },
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<OAuthFlowResult> {
	try {
		return await authenticate(config, ctx, signal);
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			throw new Error(AUTH_MESSAGES.cancelled);
		}
		throw error;
	}
}

async function authenticate(
	config: OAuth2Config & { redirectUri?: string },
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
): Promise<OAuthFlowResult> {
	try {
		const deviceFlow = await initiateDeviceFlow(config);

		// The device code panel stays up until auth completes; closing it
		// stops the poll.
		const panel = {
			signal,
			content: (theme: Theme) => [
				` ${theme.bold("📱 Device Flow Authentication")}`,
				"",
				" Visit this URL in any browser:",
				` ${theme.fg("accent", deviceFlow.verification_url)}`,
				"",
				" Enter this code:",
				` ${theme.fg("accent", theme.bold(deviceFlow.user_code))}`,
				"",
				` ${theme.fg("dim", "Waiting for authorization...")}`,
			],
		};

		openInBrowser(deviceFlow.verification_url);

		const credentials = await viewWhile(ctx, panel, (stop) =>
			pollForDeviceAuthorization(
				config,
				deviceFlow.device_code,
				deviceFlow.interval,
				stop,
			),
		);
		return { credentials, flowUsed: "device" };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);

		if (
			message.includes("invalid_client") ||
			message.includes("Invalid OAuth client type")
		) {
			return await authenticateWithWebRedirect(config, ctx, signal);
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
	signal: AbortSignal | undefined,
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

	// The waiting panel stays up until the callback arrives; closing it
	// frees the port.
	const panel = {
		signal,
		content: (theme: Theme) => [
			` ${theme.bold("🌐 Web Flow Authentication")}`,
			"",
			" Your browser should open automatically.",
			" If it doesn't, visit this URL:",
			` ${theme.fg("accent", authUrl)}`,
			"",
			` ${theme.fg("dim", "Waiting for authorization...")}`,
		],
	};

	openInBrowser(authUrl);

	return viewWhile(ctx, panel, async (stop) => {
		const port = Number.parseInt(redirectUri.split(":")[2] || "8765", 10);
		const result = await waitForOAuthCallback(port, { signal: stop });

		if (result.error) {
			throw new Error(`OAuth error: ${result.error}`);
		}

		if (!result.code) {
			throw new Error("No authorization code received.");
		}

		const { tokens } = await client.getToken(result.code);
		client.setCredentials(tokens);

		return { credentials: tokens, flowUsed: "web" as const };
	});
}

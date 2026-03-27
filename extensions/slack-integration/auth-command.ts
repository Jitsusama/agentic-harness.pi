/**
 * /slack-auth command handler.
 *
 * Manages Slack authentication: run the OAuth flow, check
 * status, or clear credentials.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { view } from "../lib/ui/panel.js";
import { SlackClient } from "./api/client.js";
import { openInBrowser } from "./auth/browser.js";
import {
	clearAllConfig,
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

/**
 * Handle /slack-auth command.
 *
 * Flags:
 *   --status   Show current auth status
 *   --logout   Clear all stored credentials
 *   (default)  Run the OAuth flow
 */
export async function handleSlackAuthCommand(
	args: string | undefined,
	ctx: ExtensionContext,
	oauthApp: OAuthApp,
): Promise<void> {
	const trimmed = (args || "").trim();

	if (trimmed === "--status") {
		await showStatus(ctx);
		return;
	}

	if (trimmed === "--logout") {
		clearAllConfig();
		ctx.ui.notify("✓ Slack credentials cleared.", "info");
		return;
	}

	if (!ctx.hasUI) {
		ctx.ui.notify("Authentication requires interactive mode.", "error");
		return;
	}

	if (!oauthApp.clientId || !oauthApp.clientSecret) {
		await view(ctx, {
			content: (theme) => [
				` ${theme.bold("⚠ Slack OAuth Credentials Missing")}`,
				"",
				" Set these environment variables:",
				` ${theme.fg("accent", "SLACK_CLIENT_ID")}`,
				` ${theme.fg("accent", "SLACK_CLIENT_SECRET")}`,
				"",
				" Or run /slack-setup for interactive configuration.",
			],
		});
		return;
	}

	try {
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
				throw new Error("No authorization code received.");
			}
			if (callback.state !== state) {
				throw new Error("OAuth state mismatch.");
			}

			const token = await exchangeCodeForToken(oauthApp, callback.code);
			storeToken(token);

			const client = new SlackClient(token.accessToken);
			await client.call("auth.test");

			ctx.ui.notify(
				`✓ Authenticated with Slack${token.teamName ? ` (${token.teamName})` : ""}`,
				"info",
			);
		} finally {
			dismiss.abort();
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);

		if (message.includes("cancelled") || message.includes("aborted")) {
			ctx.ui.notify("Authentication cancelled.", "info");
		} else if (message.includes("timeout")) {
			ctx.ui.notify(
				"Authentication timed out. Run /slack-auth to try again.",
				"error",
			);
		} else {
			ctx.ui.notify(`Authentication failed: ${message}`, "error");
		}
	}
}

/** Show current authentication status. */
async function showStatus(ctx: ExtensionContext): Promise<void> {
	if (!hasToken()) {
		ctx.ui.notify(
			"Not authenticated with Slack. Run /slack-auth to authenticate.",
			"info",
		);
		return;
	}

	const token = getToken();
	if (!token) {
		ctx.ui.notify("No stored token found.", "info");
		return;
	}

	try {
		const client = new SlackClient(token.accessToken);
		const response = await client.call<{ user?: string; team?: string }>(
			"auth.test",
		);

		await view(ctx, {
			content: (theme) => [
				` ${theme.bold("Slack Authentication Status")}`,
				"",
				` ${theme.fg("muted", "User:")} ${response.user ?? "unknown"}`,
				` ${theme.fg("muted", "Team:")} ${response.team ?? token.teamName ?? "unknown"}`,
				` ${theme.fg("muted", "Scopes:")} ${token.scopes}`,
				"",
				` ${theme.fg("success", "✓ Token is valid")}`,
			],
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`Token verification failed: ${message}`, "error");
	}
}

/** Generate a random state parameter for CSRF protection. */
function generateState(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

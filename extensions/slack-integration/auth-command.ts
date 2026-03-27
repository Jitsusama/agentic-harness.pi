/**
 * /slack-auth command handler.
 *
 * Manages Slack authentication: run setup, check status, or
 * clear credentials.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { view } from "../lib/ui/panel.js";
import { SlackClient } from "./api/client.js";
import { clearAllConfig, getToken, hasToken } from "./auth/credentials.js";
import { ensureSetup } from "./setup-wizard.js";
import type { OAuthApp } from "./types.js";

/**
 * Handle /slack-auth command.
 *
 * Flags:
 *   --status   Show current auth status
 *   --logout   Clear all stored credentials
 *   (default)  Run the setup wizard
 */
export async function handleSlackAuthCommand(
	args: string | undefined,
	ctx: ExtensionContext,
	envConfig: OAuthApp,
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

	await ensureSetup(ctx, envConfig);
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
		const client = new SlackClient(token.accessToken, token.cookie);
		const response = await client.call<{ user?: string; team?: string }>(
			"auth.test",
		);

		const authMode = token.cookie ? "browser session" : "OAuth";

		await view(ctx, {
			content: (theme) => [
				` ${theme.bold("Slack Authentication Status")}`,
				"",
				` ${theme.fg("muted", "User:")} ${response.user ?? "unknown"}`,
				` ${theme.fg("muted", "Team:")} ${response.team ?? token.teamName ?? "unknown"}`,
				` ${theme.fg("muted", "Mode:")} ${authMode}`,
				"",
				` ${theme.fg("success", "✓ Token is valid")}`,
			],
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`Token verification failed: ${message}`, "error");
	}
}

/**
 * Interactive setup wizard that walks users through creating
 * a Slack app and storing OAuth credentials.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { promptSingle } from "../lib/ui/panel.js";
import {
	getOAuthApp,
	hasOAuthApp,
	type OAuthApp,
	storeOAuthApp,
} from "./auth/credentials.js";

/**
 * Ensure OAuth app credentials are configured. Checks env vars,
 * stored credentials, then runs the interactive wizard.
 */
export async function ensureOAuthApp(
	ctx: ExtensionContext,
	envConfig: OAuthApp,
): Promise<OAuthApp | null> {
	if (envConfig.clientId && envConfig.clientSecret) {
		return envConfig;
	}

	if (hasOAuthApp()) {
		const stored = getOAuthApp();
		if (stored) return stored;
	}

	if (!ctx.hasUI) {
		ctx.ui.notify(
			"Slack OAuth credentials not configured. Set SLACK_CLIENT_ID and SLACK_CLIENT_SECRET.",
			"error",
		);
		return null;
	}

	return await runSetupWizard(ctx);
}

/** Run the interactive OAuth setup wizard. */
async function runSetupWizard(ctx: ExtensionContext): Promise<OAuthApp | null> {
	const proceed = await promptSingle(ctx, {
		content: (theme) => [
			` ${theme.bold("⚙️  Slack Integration Setup")}`,
			"",
			" To use Slack features, you need a Slack app with OAuth credentials.",
			" This is a one-time setup that takes about 5 minutes.",
			"",
			` ${theme.bold(" Steps:")}`,
			"",
			' 1. Go to https://api.slack.com/apps and click "Create New App"',
			'    Choose "From scratch", name it anything, pick your workspace.',
			"",
			' 2. Go to "OAuth & Permissions" in the sidebar.',
			'    Under "Redirect URLs", add: http://localhost:8766',
			"",
			' 3. Under "User Token Scopes", add these scopes:',
			`    ${theme.fg("dim", "search:read, channels:read, channels:history,")}`,
			`    ${theme.fg("dim", "groups:read, groups:history, im:read, im:history,")}`,
			`    ${theme.fg("dim", "mpim:read, mpim:history, chat:write,")}`,
			`    ${theme.fg("dim", "users:read, users.profile:read,")}`,
			`    ${theme.fg("dim", "reactions:read, reactions:write")}`,
			"",
			' 4. Go to "Basic Information" in the sidebar.',
			"    Copy the Client ID and Client Secret.",
		],
		options: [
			{ label: "I have my credentials ready", value: "continue" },
			{ label: "Cancel", value: "cancel" },
		],
	});

	if (!proceed || proceed.type !== "option" || proceed.value !== "continue") {
		ctx.ui.notify("Setup cancelled. Run /slack-setup when ready.", "info");
		return null;
	}

	const clientId = await ctx.ui.editor("Enter your Slack App Client ID:", "");
	if (!clientId) {
		ctx.ui.notify("Setup cancelled. Run /slack-setup when ready.", "info");
		return null;
	}

	const cleanClientId = clientId.trim();
	if (!cleanClientId) {
		ctx.ui.notify("Client ID is required.", "error");
		return null;
	}

	const clientSecret = await ctx.ui.editor(
		"Enter your Slack App Client Secret:",
		"",
	);
	if (!clientSecret) {
		ctx.ui.notify("Setup cancelled. Run /slack-setup when ready.", "info");
		return null;
	}

	const cleanClientSecret = clientSecret.trim();
	if (!cleanClientSecret) {
		ctx.ui.notify("Client Secret is required.", "error");
		return null;
	}

	const credentials: OAuthApp = {
		clientId: cleanClientId,
		clientSecret: cleanClientSecret,
	};

	storeOAuthApp(credentials);
	ctx.ui.notify(
		"✓ Slack OAuth credentials saved. Run /slack-auth to authenticate.",
		"info",
	);

	return credentials;
}

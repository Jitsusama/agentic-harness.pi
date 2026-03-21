/**
 * Interactive setup wizard that walks users through creating
 * OAuth credentials and stores them persistently.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { prompt } from "../lib/ui/panel.js";
import {
	getOAuthApp,
	hasOAuthApp,
	type OAuthAppCredentials,
	storeOAuthApp,
} from "./auth/credentials.js";
import {
	ERRORS,
	isValidClientId,
	isValidClientSecret,
} from "./setup-instructions.js";

/**
 * Check if OAuth app is configured, and if not, run the setup wizard.
 *
 * Priority order:
 * 1. Environment variables (highest priority, no prompts)
 * 2. Stored credentials (from previous setup)
 * 3. Interactive wizard (prompts user if UI available)
 */
export async function ensureOAuthApp(
	ctx: ExtensionContext,
	envConfig: OAuthAppCredentials,
): Promise<OAuthAppCredentials | null> {
	if (envConfig.clientId && envConfig.clientSecret) {
		return envConfig;
	}

	if (hasOAuthApp()) {
		const stored = getOAuthApp();
		if (stored) return stored;
	}

	if (!ctx.hasUI) {
		ctx.ui.notify(
			"OAuth credentials not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.",
			"error",
		);
		return null;
	}

	return await runSetupWizard(ctx);
}

/**
 * Run the interactive OAuth setup wizard using shared prompt panels.
 */
async function runSetupWizard(
	ctx: ExtensionContext,
): Promise<OAuthAppCredentials | null> {
	// Step 1: Show instructions and ask to proceed
	const proceed = await prompt(ctx, {
		content: (theme) => [
			` ${theme.bold("⚙️  Google Workspace Setup")}`,
			"",
			" To use Google Workspace features, you need OAuth credentials.",
			" This is a one-time setup that takes about 5 minutes.",
			"",
			` ${theme.bold(" Steps:")}`,
			"",
			` 1. Create a Google Cloud project`,
			`    ${theme.fg("accent", "https://console.cloud.google.com/projectcreate")}`,
			"",
			" 2. Enable Gmail, Calendar, Drive, Docs, Sheets, Slides APIs",
			`    ${theme.fg("accent", "https://console.cloud.google.com/flows/enableapi?apiid=gmail.googleapis.com,calendar-json.googleapis.com,drive.googleapis.com,docs.googleapis.com,sheets.googleapis.com,slides.googleapis.com")}`,
			"",
			` 3. Create OAuth credentials (Desktop app or TV/Limited Input)`,
			`    ${theme.fg("accent", "https://console.cloud.google.com/apis/credentials")}`,
			"",
			` ${theme.fg("dim", "This is completely free and requires no billing.")}`,
		],
		options: [
			{ label: "I have my credentials ready", value: "continue" },
			{ label: "Cancel", value: "cancel" },
		],
	});

	if (!proceed || proceed.type !== "action" || proceed.value !== "continue") {
		ctx.ui.notify("Setup cancelled. Run /google-setup when ready.", "info");
		return null;
	}

	// Step 2: Prompt for Client ID
	const clientId = await ctx.ui.editor(
		"Enter your OAuth Client ID (ends with .apps.googleusercontent.com):",
		"",
	);

	if (!clientId) {
		ctx.ui.notify("Setup cancelled. Run /google-setup when ready.", "info");
		return null;
	}

	const cleanClientId = clientId.trim();
	if (!isValidClientId(cleanClientId)) {
		ctx.ui.notify(ERRORS.invalidClientId, "error");
		return null;
	}

	// Step 3: Prompt for Client Secret
	const clientSecret = await ctx.ui.editor(
		"Enter your OAuth Client Secret:",
		"",
	);

	if (!clientSecret) {
		ctx.ui.notify("Setup cancelled. Run /google-setup when ready.", "info");
		return null;
	}

	const cleanClientSecret = clientSecret.trim();
	if (!isValidClientSecret(cleanClientSecret)) {
		ctx.ui.notify(ERRORS.missingClientSecret, "error");
		return null;
	}

	// We store the credentials and confirm.
	const credentials: OAuthAppCredentials = {
		clientId: cleanClientId,
		clientSecret: cleanClientSecret,
	};

	storeOAuthApp(credentials);
	ctx.ui.notify(
		"✓ OAuth credentials saved. Run /google-auth to authenticate.",
		"info",
	);

	return credentials;
}

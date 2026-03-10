/**
 * Interactive OAuth app setup wizard.
 * Guides users through creating OAuth credentials and stores them persistently.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
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
	SETUP_INSTRUCTIONS,
} from "./setup-instructions.js";

/**
 * Check if OAuth app is configured, and if not, run the setup wizard.
 *
 * Priority order:
 * 1. Environment variables (highest priority, no prompts)
 * 2. Stored credentials (from previous setup)
 * 3. Interactive wizard (prompts user if UI available)
 *
 * @param pi - Extension API
 * @param ctx - Extension context
 * @param envConfig - OAuth config from environment variables
 * @returns OAuth credentials or null if setup cancelled/failed
 */
export async function ensureOAuthApp(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	envConfig: OAuthAppCredentials,
): Promise<OAuthAppCredentials | null> {
	// 1. Check environment variables first (highest priority)
	if (envConfig.clientId && envConfig.clientSecret) {
		return envConfig;
	}

	// 2. Check stored credentials
	if (hasOAuthApp(ctx)) {
		const stored = getOAuthApp(ctx);
		if (stored) {
			return stored;
		}
	}

	// 3. Run interactive setup wizard
	if (!ctx.hasUI) {
		ctx.ui.notify(SETUP_INSTRUCTIONS.envVarHelp, "error");
		return null;
	}

	return await runSetupWizard(pi, ctx);
}

/**
 * Run the interactive OAuth setup wizard.
 * Shows instructions and prompts for credentials using ctx.ui.editor().
 */
async function runSetupWizard(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): Promise<OAuthAppCredentials | null> {
	// Show welcome and instructions
	ctx.ui.notify(SETUP_INSTRUCTIONS.welcome, "info");
	ctx.ui.notify(SETUP_INSTRUCTIONS.steps, "info");

	// Prompt for Client ID
	const clientId = await ctx.ui.editor("Enter your OAuth Client ID:", "");

	if (!clientId) {
		ctx.ui.notify(SETUP_INSTRUCTIONS.cancelled, "warn");
		return null;
	}

	const cleanClientId = clientId.trim();

	if (!isValidClientId(cleanClientId)) {
		ctx.ui.notify(ERRORS.invalidClientId, "error");
		return null;
	}

	// Prompt for Client Secret
	const clientSecret = await ctx.ui.editor(
		"Enter your OAuth Client Secret:",
		"",
	);

	if (!clientSecret) {
		ctx.ui.notify(SETUP_INSTRUCTIONS.cancelled, "warn");
		return null;
	}

	const cleanClientSecret = clientSecret.trim();

	if (!isValidClientSecret(cleanClientSecret)) {
		ctx.ui.notify(ERRORS.missingClientSecret, "error");
		return null;
	}

	// Store credentials
	const credentials: OAuthAppCredentials = {
		clientId: cleanClientId,
		clientSecret: cleanClientSecret,
	};

	storeOAuthApp(pi, credentials);
	ctx.ui.notify(SETUP_INSTRUCTIONS.success, "success");

	return credentials;
}

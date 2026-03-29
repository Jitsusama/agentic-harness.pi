/**
 * Interactive setup wizard for Slack authentication.
 *
 * Offers three auth paths:
 *   1. Browser extraction (recommended): launches Chrome,
 *      navigates to Slack, extracts credentials automatically.
 *      Works on any workspace, no admin approval needed.
 *   2. Curl paste: copy a curl command from DevTools.
 *      Same result, manual alternative.
 *   3. OAuth app: create a Slack app and go through OAuth2.
 *      May require workspace admin approval.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { SlackClient } from "../api/client.js";
import { promptSingle, view } from "../../ui/index.js";
import { extractFromBrowser } from "./browser-extract.js";
import {
	getOAuthApp,
	getToken,
	hasOAuthApp,
	hasToken,
	type OAuthApp,
	storeOAuthApp,
	storeToken,
} from "./credentials.js";
import { extractFromCurl } from "./extract.js";

/**
 * Ensure the user has valid Slack credentials.
 *
 * Checks for existing credentials first, then runs the
 * interactive wizard if nothing is configured.
 *
 * Returns the auth mode so the caller knows whether an
 * OAuthApp is available for the OAuth flow path.
 */
export async function ensureSetup(
	ctx: ExtensionContext,
	envConfig: OAuthApp,
): Promise<{ mode: "session" } | { mode: "oauth"; app: OAuthApp } | null> {
	// Already have a working token — no setup needed.
	if (hasToken()) {
		const token = getToken();
		if (token) {
			const client = new SlackClient(token.accessToken, token.cookie);
			try {
				await client.call("auth.test");
				return token.cookie
					? { mode: "session" }
					: { mode: "oauth", app: envConfig };
			} catch {
				// Token expired or revoked, fall through to setup.
			}
		}
	}

	// OAuth env vars present — use OAuth path.
	if (envConfig.clientId && envConfig.clientSecret) {
		return { mode: "oauth", app: envConfig };
	}

	// Stored OAuth app — use OAuth path.
	if (hasOAuthApp()) {
		const stored = getOAuthApp();
		if (stored) return { mode: "oauth", app: stored };
	}

	if (!ctx.hasUI) {
		ctx.ui.notify(
			"Slack credentials not configured. Run /slack-setup to authenticate.",
			"error",
		);
		return null;
	}

	return await runSetupWizard(ctx);
}

/** Run the interactive setup wizard. */
async function runSetupWizard(
	ctx: ExtensionContext,
): Promise<{ mode: "session" } | { mode: "oauth"; app: OAuthApp } | null> {
	const choice = await promptSingle(ctx, {
		content: (theme) => [
			` ${theme.bold("⚙️  Slack Integration Setup")}`,
			"",
			" Choose how to authenticate with Slack:",
			"",
			` ${theme.bold(" Option 1: Browser")} ${theme.fg("accent", "(recommended)")}`,
			"   Opens Chrome, logs you in, extracts credentials automatically.",
			"   Works on any workspace, no admin approval needed.",
			"",
			` ${theme.bold(" Option 2: Paste curl command")}`,
			"   Copy a curl command from browser DevTools.",
			"   Same result, just manual.",
			"",
			` ${theme.bold(" Option 3: Direct token entry")}`,
			"   Enter a token (and cookie) directly.",
			"",
			` ${theme.bold(" Option 4: OAuth app")}`,
			"   Create a Slack app and go through OAuth2.",
			"   May require workspace admin approval.",
		],
		options: [
			{ label: "Browser (automatic)", value: "browser" },
			{ label: "Paste curl command", value: "curl" },
			{ label: "Direct token + cookie", value: "direct" },
			{ label: "OAuth app", value: "oauth" },
			{ label: "Cancel", value: "cancel" },
		],
	});

	if (!choice || choice.type !== "option") return null;

	switch (choice.value) {
		case "browser":
			return await setupViaBrowser(ctx);
		case "curl":
			return await setupViaCurl(ctx);
		case "direct":
			return await setupViaDirect(ctx);
		case "oauth":
			return await setupViaOAuth(ctx);
		default:
			ctx.ui.notify("Setup cancelled. Run /slack-setup when ready.", "info");
			return null;
	}
}

// ── Browser extraction ──────────────────────────────────

async function setupViaBrowser(
	ctx: ExtensionContext,
): Promise<{ mode: "session" } | null> {
	// Ask for workspace URL so we navigate directly.
	const urlInput = await ctx.ui.editor(
		"Enter your Slack workspace URL (e.g. your-team.slack.com):",
		"",
	);
	const slackUrl = urlInput?.trim()
		? normaliseSlackUrl(urlInput.trim())
		: undefined;

	const dismiss = new AbortController();

	view(ctx, {
		signal: dismiss.signal,
		content: (theme) => [
			` ${theme.bold("🌐 Browser Credential Extraction")}`,
			"",
			` Chrome is launching and navigating to ${slackUrl ?? "Slack"}.`,
			" If you're not logged in, log in now.",
			" This can take a few minutes with SSO/2FA.",
			"",
			` ${theme.fg("dim", "Waiting for credentials (up to 5 minutes)…")}`,
		],
	});

	try {
		const creds = await extractFromBrowser(slackUrl);
		dismiss.abort();
		return await verifyAndStore(ctx, creds.token, creds.cookie);
	} catch (error) {
		dismiss.abort();
		const msg = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`Browser extraction failed: ${msg}`, "error");
		return null;
	}
}

// ── Curl paste ──────────────────────────────────────────

async function setupViaCurl(
	ctx: ExtensionContext,
): Promise<{ mode: "session" } | null> {
	const instructions = await promptSingle(ctx, {
		content: (theme) => [
			` ${theme.bold("📋 Curl Command Setup")}`,
			"",
			" 1. Open Slack in your browser (app.slack.com)",
			" 2. Open DevTools (F12 or Cmd+Option+I)",
			" 3. Go to the Network tab",
			" 4. Do anything in Slack (switch channels, etc.)",
			" 5. Find any request to api.slack.com",
			'    Right-click → "Copy as cURL"',
			"",
			` ${theme.fg("dim", "The curl command contains your token and cookie.")}`,
			` ${theme.fg("dim", "They stay on your machine — never sent anywhere else.")}`,
		],
		options: [
			{ label: "I have the curl command", value: "continue" },
			{ label: "Cancel", value: "cancel" },
		],
	});

	if (
		!instructions ||
		instructions.type !== "option" ||
		instructions.value !== "continue"
	) {
		return null;
	}

	const curlInput = await ctx.ui.editor("Paste the curl command here:", "");
	if (!curlInput) return null;

	try {
		const creds = extractFromCurl(curlInput);
		return await verifyAndStore(ctx, creds.token, creds.cookie);
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`Failed to extract credentials: ${msg}`, "error");
		return null;
	}
}

// ── Direct token entry ──────────────────────────────────

async function setupViaDirect(
	ctx: ExtensionContext,
): Promise<{ mode: "session" } | null> {
	const tokenInput = await ctx.ui.editor(
		"Enter your Slack token (xoxc-… or xoxp-…):",
		"",
	);
	if (!tokenInput) return null;
	const token = tokenInput.trim();

	if (!token.startsWith("xox")) {
		ctx.ui.notify("Token must start with xoxc-, xoxp-, or xoxb-.", "error");
		return null;
	}

	// xoxp- tokens don't need a cookie.
	if (token.startsWith("xoxp-")) {
		return await verifyAndStore(ctx, token);
	}

	const cookieInput = await ctx.ui.editor(
		"Enter your Slack session cookie (xoxd-…):",
		"",
	);
	if (!cookieInput) return null;
	const cookie = cookieInput.trim();

	if (!cookie.startsWith("xoxd-")) {
		ctx.ui.notify("Cookie must start with xoxd-.", "error");
		return null;
	}

	return await verifyAndStore(ctx, token, cookie);
}

// ── OAuth app setup ─────────────────────────────────────

async function setupViaOAuth(
	ctx: ExtensionContext,
): Promise<{ mode: "oauth"; app: OAuthApp } | null> {
	const proceed = await promptSingle(ctx, {
		content: (theme) => [
			` ${theme.bold("🔐 OAuth App Setup")}`,
			"",
			" This requires creating a Slack app (may need admin approval).",
			"",
			' 1. Go to https://api.slack.com/apps → "Create New App"',
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
			' 4. Go to "Basic Information" → copy Client ID and Client Secret.',
		],
		options: [
			{ label: "I have my credentials ready", value: "continue" },
			{ label: "Cancel", value: "cancel" },
		],
	});

	if (!proceed || proceed.type !== "option" || proceed.value !== "continue") {
		return null;
	}

	const clientId = await ctx.ui.editor("Enter your Slack App Client ID:", "");
	if (!clientId?.trim()) return null;

	const clientSecret = await ctx.ui.editor(
		"Enter your Slack App Client Secret:",
		"",
	);
	if (!clientSecret?.trim()) return null;

	const app: OAuthApp = {
		clientId: clientId.trim(),
		clientSecret: clientSecret.trim(),
	};

	storeOAuthApp(app);
	ctx.ui.notify(
		"✓ OAuth credentials saved. Run /slack-auth to authenticate.",
		"info",
	);

	return { mode: "oauth", app };
}

// ── Shared verification ─────────────────────────────────

/** Verify credentials with auth.test and store them. */
async function verifyAndStore(
	ctx: ExtensionContext,
	token: string,
	cookie?: string,
): Promise<{ mode: "session" } | null> {
	const client = new SlackClient(token, cookie);

	try {
		const auth = await client.call<{
			user_id?: string;
			user?: string;
			team_id?: string;
			team?: string;
		}>("auth.test");

		storeToken({
			accessToken: token,
			cookie,
			userId: (auth.user_id as string) ?? "",
			teamId: (auth.team_id as string) ?? "",
			teamName: (auth.team as string) ?? undefined,
			scopes: "browser-session",
		});

		ctx.ui.notify(
			`✓ Authenticated as ${auth.user ?? "unknown"} in ${auth.team ?? "unknown"}`,
			"info",
		);

		return { mode: "session" };
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`Authentication failed: ${msg}`, "error");
		return null;
	}
}

/** Normalise a workspace input into a full https URL. */
function normaliseSlackUrl(input: string): string {
	// Already a full URL.
	if (input.startsWith("https://") || input.startsWith("http://")) {
		return input;
	}
	// Bare domain like "myteam.slack.com".
	return `https://${input}`;
}

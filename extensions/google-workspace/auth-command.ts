/**
 * Google Workspace authentication command handler.
 * Uses OAuth 2.0 with automatic device/web flow fallback.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { OAuth2Client } from "google-auth-library";
import { view } from "../lib/ui/panel.js";
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
 * Handle /google-auth command.
 */
export async function handleGoogleAuthCommand(
	args: string | undefined,
	ctx: ExtensionContext,
	oauthConfig: OAuthConfig,
): Promise<void> {
	const parts = (args || "").trim().split(/\s+/);
	const flags = parseFlags(parts);

	if (flags.list) {
		await showAccountList(ctx);
		return;
	}

	if (flags.default) {
		setDefaultAccount(flags.default);
		ctx.ui.notify(`Default account set to: ${flags.default}`, "info");
		return;
	}

	if (!ctx.hasUI) {
		ctx.ui.notify("Authentication requires interactive mode.", "error");
		return;
	}

	if (!oauthConfig.clientId || !oauthConfig.clientSecret) {
		await view(ctx, {
			content: (theme) => [
				` ${theme.bold("⚠ OAuth Credentials Missing")}`,
				"",
				" Set these environment variables:",
				` ${theme.fg("accent", "GOOGLE_CLIENT_ID")}`,
				` ${theme.fg("accent", "GOOGLE_CLIENT_SECRET")}`,
				"",
				" Or run /google-setup for interactive configuration.",
			],
		});
		return;
	}

	const accountName = flags.account || "work";

	try {
		const abortController = new AbortController();
		const cancelHandler = () => abortController.abort();
		process.on("SIGINT", cancelHandler);

		try {
			const result = await authenticateWithFallback(
				{ ...oauthConfig, redirectUri: "http://localhost:8765" },
				ctx,
				abortController.signal,
			);

			const client = createOAuth2Client(oauthConfig);
			setCredentials(client, result.credentials);
			const email = await extractEmailFromToken(client);

			storeCredentials(accountName, result.credentials);
			saveAccount({
				name: accountName,
				email,
				isDefault: listAccounts().length === 0,
			});

			const flowType =
				result.flowUsed === "device" ? "device flow" : "web redirect";
			ctx.ui.notify(
				`✓ Authenticated as '${accountName}'${email ? ` (${email})` : ""} via ${flowType}`,
				"info",
			);
		} finally {
			process.off("SIGINT", cancelHandler);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);

		if (message.includes("cancelled") || message.includes("aborted")) {
			ctx.ui.notify("Authentication cancelled.", "info");
		} else if (message.includes("expired")) {
			ctx.ui.notify("Code expired. Run /google-auth to try again.", "error");
		} else if (message.includes("denied")) {
			ctx.ui.notify("Authorization denied by user.", "error");
		} else {
			ctx.ui.notify(`Authentication failed: ${message}`, "error");
		}
	}
}

/** Show configured accounts in a view panel. */
async function showAccountList(ctx: ExtensionContext): Promise<void> {
	const accounts = listAccounts();

	if (accounts.length === 0) {
		ctx.ui.notify(
			"No accounts configured. Run /google-auth to add one.",
			"info",
		);
		return;
	}

	await view(ctx, {
		content: (theme) => {
			const lines = [` ${theme.bold("Google Workspace Accounts")}`, ""];
			for (const acc of accounts) {
				const marker = acc.isDefault ? theme.fg("accent", " (default)") : "";
				const email = acc.email ? theme.fg("dim", ` ${acc.email}`) : "";
				lines.push(` ${acc.name}${email}${marker}`);
			}
			return lines;
		},
	});
}

/** Extract email address from an OAuth2 token. */
async function extractEmailFromToken(
	client: OAuth2Client,
): Promise<string | undefined> {
	try {
		const tokenInfo = await client.getTokenInfo(
			client.credentials.access_token || "",
		);
		return tokenInfo.email;
	} catch {
		// Token info fetch failed — non-critical
		return undefined;
	}
}

/** Parse command flags from arguments. */
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

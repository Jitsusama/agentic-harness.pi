/**
 * Google Workspace Extension
 *
 * Provides AI-friendly access to Gmail, Calendar, Drive, Docs, Sheets,
 * and Slides through a single `google` tool. Handles OAuth2 authentication,
 * token refresh, and renders content as markdown.
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import type { OAuth2Client } from "google-auth-library";

import {
	getCredentials,
	getDefaultAccount,
	listAccounts,
	saveAccount,
	setDefaultAccount,
	storeCredentials,
} from "./auth/credentials.js";
import {
	createOAuth2Client,
	exchangeCodeForTokens,
	getAuthUrl,
	refreshTokenIfNeeded,
	setCredentials,
} from "./auth/oauth.js";
import { waitForOAuthCallback } from "./auth/server.js";
import { routeAction } from "./router.js";

// OAuth2 configuration from environment variables
const OAUTH_PORT = 8765;
const OAUTH_CONFIG = {
	clientId: process.env.GOOGLE_CLIENT_ID || "",
	clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
	redirectUri: `http://localhost:${OAUTH_PORT}`,
};

export default function googleWorkspace(pi: ExtensionAPI) {
	// Cache of OAuth clients per account
	const oauthClients = new Map<string, OAuth2Client>();

	/**
	 * Get or create an authenticated OAuth2 client for an account.
	 */
	async function getAuthClient(
		ctx: ExtensionContext,
		accountName: string,
	): Promise<OAuth2Client> {
		// Check cache first
		let client = oauthClients.get(accountName);
		if (client) {
			// Refresh token if needed
			const newCreds = await refreshTokenIfNeeded(client);
			if (newCreds) {
				storeCredentials(pi, ctx, accountName, newCreds);
			}
			return client;
		}

		// Load stored credentials
		const credentials = getCredentials(ctx, accountName);
		if (!credentials) {
			throw new Error(
				`Not authenticated. Run: google-auth --account ${accountName}`,
			);
		}

		// Create new client and set credentials
		client = createOAuth2Client(OAUTH_CONFIG);
		setCredentials(client, credentials);

		// Refresh if needed
		const newCreds = await refreshTokenIfNeeded(client);
		if (newCreds) {
			storeCredentials(pi, ctx, accountName, newCreds);
		}

		oauthClients.set(accountName, client);
		return client;
	}

	// ---- Tool Registration ----

	pi.registerTool({
		name: "google",
		label: "Google Workspace",
		description:
			"Access Google Workspace (Gmail, Calendar, Drive, Docs, Sheets, Slides). Use when asked to check email, view calendar, open Google docs, search Drive, or access any Google Workspace data.",
		promptSnippet:
			"Access Google Workspace (Gmail, Calendar, Drive, Docs, Sheets, Slides). Use when asked to check email, view calendar, open Google docs, search Drive, or access any Google Workspace data.",
		promptGuidelines: [
			"Read the google-workspace skill for translating natural language to API actions.",
			"Remember context from previous results - user may reference 'that email', 'the second one', etc.",
			"Parse relative dates (today, tomorrow, next week) to ISO format.",
			"Extract email addresses and infer domains (@shopify.com for first names).",
			"For replies, use send_email with reply_to parameter and extract recipient from context.",
			"Confirmation gates allow editing - don't re-prompt for details user already provided.",
		],
		parameters: Type.Object({
			action: StringEnum(
				[
					"search_emails",
					"get_email",
					"get_thread",
					"send_email",
					"create_draft",
					"archive_email",
					"delete_email",
					"mark_read",
					"mark_unread",
					"list_events",
					"get_event",
					"create_event",
					"update_event",
					"delete_event",
					"respond_to_event",
					"list_files",
					"get_file",
					"list_shared_drives",
				] as const,
				{ description: "The operation to perform" },
			),
			account: Type.Optional(
				Type.String({
					description: "Google account to use (default: primary)",
				}),
			),
			// Gmail parameters
			query: Type.Optional(Type.String({ description: "Gmail search query" })),
			id: Type.Optional(Type.String({ description: "Message or event ID" })),
			message_id: Type.Optional(
				Type.String({ description: "Message ID for thread lookup" }),
			),
			limit: Type.Optional(
				Type.Number({ description: "Maximum results (default: 25)" }),
			),
			page_token: Type.Optional(
				Type.String({ description: "Pagination token" }),
			),
			// Email write parameters
			to: Type.Optional(
				Type.Array(Type.String(), { description: "Recipient email addresses" }),
			),
			subject: Type.Optional(Type.String({ description: "Email subject" })),
			body: Type.Optional(
				Type.String({ description: "Email body (plain text)" }),
			),
			cc: Type.Optional(
				Type.Array(Type.String(), { description: "CC recipients" }),
			),
			bcc: Type.Optional(
				Type.Array(Type.String(), { description: "BCC recipients" }),
			),
			reply_to: Type.Optional(
				Type.String({ description: "Message ID to reply to" }),
			),
			// Calendar parameters
			start: Type.Optional(
				Type.String({ description: "Start date (ISO or 'today'/'tomorrow')" }),
			),
			end: Type.Optional(Type.String({ description: "End date (ISO)" })),
			calendar_id: Type.Optional(
				Type.String({ description: "Calendar ID (default: primary)" }),
			),
			event_id: Type.Optional(Type.String({ description: "Event ID" })),
			summary: Type.Optional(
				Type.String({ description: "Event summary/title" }),
			),
			description: Type.Optional(
				Type.String({ description: "Event description" }),
			),
			location: Type.Optional(Type.String({ description: "Event location" })),
			attendees: Type.Optional(
				Type.Array(Type.String(), {
					description: "Attendee email addresses",
				}),
			),
			response: Type.Optional(
				Type.String({
					description: "Response: accepted, declined, tentative",
				}),
			),
			// Drive parameters
			url: Type.Optional(
				Type.String({ description: "Google Drive/Docs URL to parse" }),
			),
			folder_id: Type.Optional(Type.String({ description: "Folder ID" })),
			type: Type.Optional(
				Type.String({
					description: "File type filter: doc, sheet, slides, folder, pdf",
				}),
			),
			owner: Type.Optional(
				Type.String({ description: "Owner filter: 'me' or email address" }),
			),
			shared: Type.Optional(
				Type.Boolean({ description: "Filter to shared files" }),
			),
			shared_drive_id: Type.Optional(
				Type.String({ description: "Shared Drive ID" }),
			),
			order_by: Type.Optional(
				Type.String({
					description: "Sort order: modifiedTime, name, relevance",
				}),
			),
			include_comments: Type.Optional(
				Type.Boolean({ description: "Include document comments" }),
			),
			comments_filter: Type.Optional(
				Type.String({
					description: "Comment filter: all, resolved, unresolved",
				}),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { action, account: accountName } = params;

			try {
				// Determine which account to use
				const account = accountName
					? (accountName as string)
					: getDefaultAccount(ctx)?.name || "work";

				// Get authenticated client
				const auth = await getAuthClient(ctx, account);

				// Route to appropriate handler
				return await routeAction(action as string, params, auth, ctx);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [
						{
							type: "text" as const,
							text: `Google Workspace API error: ${message}`,
						},
					],
				};
			}
		},

		renderCall(args, _options, theme) {
			const a = args as { action?: string; query?: string };
			const action = a.action || "?";
			let text = theme.fg("toolTitle", theme.bold("google "));
			text += action;
			if (a.query) {
				const preview =
					a.query.length > 40 ? `${a.query.slice(0, 40)}...` : a.query;
				text += theme.fg("dim", ` "${preview}"`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const d = result.details as
				| {
						messages?: unknown[];
						events?: unknown[];
						files?: unknown[];
						drives?: unknown[];
						file?: { name?: string };
				  }
				| undefined;

			if (d?.messages) {
				const count = Array.isArray(d.messages) ? d.messages.length : 0;
				return new Text(
					theme.fg("success", `✓ ${count} message${count !== 1 ? "s" : ""}`),
					0,
					0,
				);
			}

			if (d?.events) {
				const count = Array.isArray(d.events) ? d.events.length : 0;
				return new Text(
					theme.fg("success", `✓ ${count} event${count !== 1 ? "s" : ""}`),
					0,
					0,
				);
			}

			if (d?.files) {
				const count = Array.isArray(d.files) ? d.files.length : 0;
				return new Text(
					theme.fg("success", `✓ ${count} file${count !== 1 ? "s" : ""}`),
					0,
					0,
				);
			}

			if (d?.drives) {
				const count = Array.isArray(d.drives) ? d.drives.length : 0;
				return new Text(
					theme.fg("success", `✓ ${count} drive${count !== 1 ? "s" : ""}`),
					0,
					0,
				);
			}

			if (d?.file) {
				const name =
					typeof d.file === "object" && d.file !== null && "name" in d.file
						? String(d.file.name)
						: "file";
				return new Text(theme.fg("success", `✓ ${name}`), 0, 0);
			}

			return new Text(theme.fg("success", "✓"), 0, 0);
		},
	});

	// ---- Authentication Command ----

	pi.registerCommand("google-auth", {
		description:
			"Authenticate with Google Workspace. Usage: google-auth [--account name] [--list] [--default name]",
		handler: async (args, ctx) => {
			const parts = (args || "").trim().split(/\s+/);
			const flags = parseFlags(parts);

			// List accounts
			if (flags.list) {
				const accounts = listAccounts(ctx);
				if (accounts.length === 0) {
					ctx.ui.notify("No accounts configured.", "info");
					return;
				}
				for (const acc of accounts) {
					const marker = acc.isDefault ? " (default)" : "";
					const email = acc.email ? ` - ${acc.email}` : "";
					ctx.ui.notify(`${acc.name}${email}${marker}`, "info");
				}
				return;
			}

			// Set default account
			if (flags.default) {
				setDefaultAccount(pi, ctx, flags.default);
				ctx.ui.notify(`Default account set to: ${flags.default}`, "success");
				return;
			}

			// Authenticate
			const accountName = flags.account || "work";

			if (!ctx.hasUI) {
				ctx.ui.notify("Authentication requires UI.", "error");
				return;
			}

			try {
				// Validate OAuth config
				if (!OAUTH_CONFIG.clientId || !OAUTH_CONFIG.clientSecret) {
					ctx.ui.notify(
						"OAuth credentials not configured.\n\n" +
							"Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET environment variables.\n" +
							"See extensions/google-workspace/README.md for setup instructions.",
						"error",
					);
					return;
				}

				// Create OAuth client
				const client = createOAuth2Client(OAUTH_CONFIG);
				const authUrl = getAuthUrl(client);

				ctx.ui.notify(
					`Opening browser for Google authentication...\n\nVisit: ${authUrl}\n\nWaiting for callback on http://localhost:${OAUTH_PORT}...`,
					"info",
				);

				// TODO: Auto-open browser when Pi supports it
				// For now, user must manually open the URL

				// Start local server and wait for OAuth callback
				const result = await waitForOAuthCallback(OAUTH_PORT);

				if (result.error) {
					ctx.ui.notify(`OAuth error: ${result.error}`, "error");
					return;
				}

				if (!result.code) {
					ctx.ui.notify("No authorization code received.", "error");
					return;
				}

				// Exchange code for tokens
				const credentials = await exchangeCodeForTokens(client, result.code);

				// Store credentials
				storeCredentials(pi, ctx, accountName, credentials);

				// Save account info
				saveAccount(pi, ctx, {
					name: accountName,
					email: undefined, // TODO: Extract from token
					isDefault: listAccounts(ctx).length === 0, // First account is default
				});

				ctx.ui.notify(`✓ Authenticated as account '${accountName}'`, "success");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Authentication failed: ${message}`, "error");
			}
		},
	});
}

// Helper functions

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

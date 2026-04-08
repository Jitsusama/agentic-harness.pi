/**
 * Google Workspace Integration Extension
 *
 * Provides AI-friendly access to Gmail, Calendar, Drive, Docs, Sheets,
 * and Slides through a single `google` tool. Handles OAuth2 authentication,
 * token refresh, and renders content as markdown.
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { OAuth2Client } from "google-auth-library";
import { clearAllConfig } from "../../lib/google/auth/credentials.js";
import {
	ensureAuthenticated,
	formatAuthError,
} from "../../lib/google/auth/ensure-auth.js";
import { ensureOAuthApp } from "../../lib/google/auth/setup-wizard.js";
import { handleGoogleAuthCommand } from "./auth-command.js";
import { renderGoogleCall } from "./render-call.js";
import { renderGoogleResult } from "./render-result.js";
import { routeAction } from "./router.js";

// OAuth2 configuration from environment variables.
const ENV_OAUTH_CONFIG = {
	clientId: process.env.GOOGLE_CLIENT_ID || "",
	clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
};

export default function googleWorkspace(pi: ExtensionAPI) {
	/** Cached OAuth clients keyed by account name. */
	const clientCache = new Map<string, OAuth2Client>();

	/**
	 * Get an authenticated Google client, prompting for setup
	 * and auth if needed. Caches the client for the session.
	 */
	async function getClient(
		ctx: Parameters<typeof ensureAuthenticated>[0],
		account?: string,
	): Promise<OAuth2Client> {
		const key = account ?? "__default__";
		const cached = clientCache.get(key);
		if (cached) return cached;

		const client = await ensureAuthenticated(ctx, ENV_OAUTH_CONFIG, account);
		clientCache.set(key, client);
		return client;
	}

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
			"To view another person's calendar, use list_events with their email as calendar_id. To find common free time across multiple people, use check_availability (includes your calendar automatically). Two-step scheduling: check_availability first, then create_event with the chosen slot.",
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
					"unarchive_email",
					"delete_email",
					"mark_read",
					"mark_unread",
					"list_events",
					"get_event",
					"create_event",
					"update_event",
					"delete_event",
					"respond_to_event",
					"check_availability",
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
				const auth = await getClient(ctx, accountName as string | undefined);

				return await routeAction(action as string, params, auth, ctx);
			} catch (error) {
				return {
					content: [
						{
							type: "text" as const,
							text: formatAuthError(error),
						},
					],
				};
			}
		},
		renderCall: renderGoogleCall,

		renderResult: renderGoogleResult,
	});

	pi.registerCommand("google-setup", {
		description: "Set up Google OAuth credentials (interactive)",
		handler: async (_args, ctx) => {
			await ensureOAuthApp(ctx, ENV_OAUTH_CONFIG);
		},
	});

	pi.registerCommand("google-auth", {
		description:
			"Authenticate with Google Workspace. Usage: google-auth [--account name] [--list] [--default name]",
		handler: async (args, ctx) => {
			const oauthConfig = await ensureOAuthApp(ctx, ENV_OAUTH_CONFIG);
			if (!oauthConfig) return;
			await handleGoogleAuthCommand(args, ctx, oauthConfig);
		},
	});

	pi.registerCommand("google-reset", {
		description:
			"Clear all Google Workspace configuration (OAuth credentials, accounts, tokens). Used for testing or starting fresh.",
		handler: async (_args, ctx) => {
			clearAllConfig();
			clientCache.clear();
			ctx.ui.notify(
				"✓ Cleared all Google Workspace configuration. Run /google-setup to start fresh.",
				"info",
			);
		},
	});
}

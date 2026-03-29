/**
 * Slack Integration Extension
 *
 * Provides AI-friendly access to Slack through a single `slack`
 * tool. Supports browser session tokens (xoxc- extracted from
 * Chrome) and OAuth2 user tokens (xoxp-). Renders content as
 * markdown-like text.
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { getLastEntry } from "../../lib/internal/state.js";
import type { SlackClient } from "../../lib/slack/api/client.js";
import { clearAllConfig, getToken } from "../../lib/slack/auth/credentials.js";
import { formatSlackText } from "../../lib/slack/renderers/message.js";
import { parseSlackUrl } from "../../lib/slack/resolvers/url.js";
import { displayNameForId } from "../../lib/slack/resolvers/user.js";
import type { OAuthApp, SlackUser } from "../../lib/slack/types.js";
import { handleSlackAuthCommand } from "./auth-command.js";
import { ensureAuthenticated, formatAuthError } from "./auth-flow.js";
import { routeAction } from "./router.js";
import { createSessionState, type SlackSessionState } from "./state.js";

/** Lightweight shapes for renderResult previews. */
interface MessagePreview {
	user?: string;
	text?: string;
	conversation?: { displayName?: string; kind?: string };
}
interface UserPreview {
	name?: string;
	realName?: string;
	displayName?: string;
	title?: string;
}
interface ChannelPreview {
	name?: string;
	topic?: string;
	memberCount?: number;
}
interface FilePreview {
	name?: string;
}

/** Truncate text to a maximum length, adding ellipsis. */
function truncateText(text: string, max: number): string {
	const oneLine = text.replace(/\n/g, " ").trim();
	if (oneLine.length <= max) return oneLine;
	return `${oneLine.slice(0, max - 1)}…`;
}

/** Resolve a user ID to @handle for previews. */
function resolveUser(userId: string | undefined): string {
	if (!userId) return "?";
	const name = displayNameForId(userId);
	return `@${name}`;
}

/**
 * Assemble the effective search query for display.
 *
 * Combines the raw query with structured parameters (from,
 * with, after, before) so the user sees the full query that
 * gets sent to Slack, not just the raw query parameter.
 */
function assembleQueryPreview(a: {
	query?: string;
	from?: string;
	with?: string;
	after?: string;
	before?: string;
	channel?: string;
	limit?: number;
}): string {
	const parts: string[] = [];
	if (a.query) parts.push(a.query);
	if (a.from) {
		const user = a.from.startsWith("@") ? a.from.slice(1) : a.from;
		parts.push(`from:${user}`);
	}
	if (a.with) {
		const user = a.with.startsWith("@") ? a.with.slice(1) : a.with;
		parts.push(`with:${user}`);
	}
	if (a.channel) {
		const ch = a.channel.startsWith("#") ? a.channel : `#${a.channel}`;
		parts.push(`in:${ch}`);
	}
	if (a.after) parts.push(`after:${a.after}`);
	if (a.before) parts.push(`before:${a.before}`);

	const full = parts.join(" ");
	if (full.length > 60) return `${full.slice(0, 59)}…`;
	return full;
}

/** Max message previews to show in collapsed view. */
const MAX_PREVIEWS = 5;

/** Render message previews with resolved usernames for collapsed view. */
function renderMessagePreviews(
	msgs: MessagePreview[],
	theme: { fg: (color: string, text: string) => string },
): string {
	const shown = msgs.slice(0, MAX_PREVIEWS);
	const lines = shown.map((m) => {
		const who = theme.fg("dim", resolveUser(m.user));
		const where = m.conversation?.displayName
			? theme.fg("muted", ` (${m.conversation.displayName})`)
			: "";
		const snippet = truncateText(formatSlackText(m.text || ""), 50);
		return `  ${who}${where}: ${snippet}`;
	});
	if (msgs.length > MAX_PREVIEWS) {
		lines.push(
			`  ${theme.fg("muted", `… ${msgs.length - MAX_PREVIEWS} more`)}`,
		);
	}
	return lines.join("\n");
}

/** Fallback OAuth config from environment variables. */
const ENV_OAUTH_CONFIG: OAuthApp = {
	clientId: process.env.SLACK_CLIENT_ID || "",
	clientSecret: process.env.SLACK_CLIENT_SECRET || "",
};

/** Session history key for persisting Slack identity. */
const SESSION_KEY = "slack-identity";

export default function slackIntegration(pi: ExtensionAPI) {
	/** Cached authenticated client. */
	let cachedClient: SlackClient | null = null;

	/** Session state: the authenticated user's identity. */
	const session = createSessionState();

	/**
	 * Get an authenticated Slack client, prompting for setup
	 * and auth if needed. Caches the client for the session.
	 */
	async function getClient(
		ctx: Parameters<typeof ensureAuthenticated>[0],
	): Promise<SlackClient> {
		if (cachedClient) return cachedClient;
		cachedClient = await ensureAuthenticated(ctx, ENV_OAUTH_CONFIG);
		return cachedClient;
	}

	/**
	 * Check whether a get_user result matches the authenticated
	 * user. If so, capture the handle in session state. This is
	 * the lazy population trigger: the agent calls get_user once
	 * and the identity is remembered for the rest of the session.
	 */
	function captureIdentityIfSelf(result: { details?: unknown }): void {
		if (session.userHandle) return;

		const user = (result.details as { user?: SlackUser } | undefined)?.user;
		if (!user?.id || !user?.name) return;

		const token = getToken();
		if (!token?.userId || token.userId !== user.id) return;

		session.userId = user.id;
		session.userHandle = user.name;
		pi.appendEntry(SESSION_KEY, {
			userId: session.userId,
			userHandle: session.userHandle,
		});
	}

	// Restore identity from previous session.
	pi.on("session_start", async (_event, ctx) => {
		const saved = getLastEntry<SlackSessionState>(ctx, SESSION_KEY);
		if (saved?.userId && saved?.userHandle) {
			session.userId = saved.userId;
			session.userHandle = saved.userHandle;
		}
	});

	// Inject identity into agent context when known.
	pi.on("before_agent_start", async () => {
		if (!session.userHandle) return;
		return {
			messages: [
				{
					type: "text" as const,
					text:
						`The authenticated Slack user is @${session.userHandle}` +
						` (${session.userId}). Use this handle for from: queries.`,
				},
			],
		};
	});

	pi.registerTool({
		name: "slack",
		label: "Slack",
		description:
			"Access Slack: search messages, read threads, send messages, " +
			"look up users and channels, manage reactions. Use when asked " +
			"to check Slack, find messages, send messages, or interact " +
			"with Slack in any way.",
		promptSnippet:
			"Access Slack: search messages, read threads, send messages, " +
			"look up users/channels, manage reactions.",
		promptGuidelines: [
			"All identifier formats (channel names, IDs, user IDs, permalink URLs) are resolved automatically. Use whatever you have from context.",
			"Parse Slack search operators: from:user, in:#channel, after:YYYY-MM-DD, before:YYYY-MM-DD. The after/before operators are exclusive: after:2026-03-26 means March 27 onward. To include today, use yesterday's date.",
			"Remember context from previous results — user may reference 'that message', 'the thread', etc.",
			"For thread replies, use reply_to_thread with the parent message's channel and ts.",
			"User handles work with or without the @ prefix.",
			"To read DMs with a person, ALWAYS use list_messages with their user ID as the channel (resolves to the DM automatically). NEVER use search_messages with 'with:' for DM history — search mixes in shared channels and misses messages. Only use 'with:' when you need keyword filtering across all conversations.",
			"search_messages cannot search DM conversations — the tool returns a clear error. Use list_messages for DMs.",
			"When the user asks about DM history over a time range, pass limit: 0 and the oldest/latest params to list_messages to get ALL messages in that window. The default limit (20) is far too small for comprehensive queries. Don't draw conclusions from partial data.",
			"The query parameter is optional for search when structured params (from, with, channel, after, before) are provided — it defaults to *.",
			"Be concise in your responses — summarise the substance of results rather than restating what the tool output already shows.",
		],
		parameters: Type.Object({
			action: StringEnum(
				[
					"search_messages",
					"search_files",
					"get_message",
					"get_thread",
					"list_messages",
					"get_channel",
					"get_user",
					"list_reactions",
					"get_reactions",
					"send_message",
					"reply_to_thread",
					"add_reaction",
					"remove_reaction",
				] as const,
				{ description: "The operation to perform" },
			),
			// Targeting
			target: Type.Optional(
				Type.String({ description: "Slack message permalink URL" }),
			),
			channel: Type.Optional(
				Type.String({
					description: "Channel name (with or without #), or channel ID",
				}),
			),
			ts: Type.Optional(Type.String({ description: "Message timestamp" })),
			user: Type.Optional(
				Type.String({
					description: "User handle (with or without @), or user ID",
				}),
			),
			// Search
			query: Type.Optional(Type.String({ description: "Search query text" })),
			from: Type.Optional(
				Type.String({ description: "Filter by sender (username)" }),
			),
			with: Type.Optional(
				Type.String({
					description:
						"Search DMs and threads with a specific person (username)",
				}),
			),
			after: Type.Optional(
				Type.String({ description: "Messages after date (YYYY-MM-DD)" }),
			),
			before: Type.Optional(
				Type.String({ description: "Messages before date (YYYY-MM-DD)" }),
			),
			// Content
			text: Type.Optional(Type.String({ description: "Message text to send" })),
			emoji: Type.Optional(
				Type.String({ description: "Emoji name (without colons)" }),
			),
			// Pagination
			limit: Type.Optional(
				Type.Number({
					description: "Maximum results (default varies by action)",
				}),
			),
			oldest: Type.Optional(
				Type.String({ description: "Only messages after this timestamp" }),
			),
			latest: Type.Optional(
				Type.String({ description: "Only messages before this timestamp" }),
			),
			// File search
			type: Type.Optional(
				Type.String({
					description: "File type filter (images, snippets, pdfs)",
				}),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const client = await getClient(ctx);
				const result = await routeAction(
					params.action as string,
					client,
					params,
					ctx,
				);
				if (params.action === "get_user") {
					captureIdentityIfSelf(result);
				}
				return result;
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

		renderCall(args, theme) {
			const a = args as {
				action?: string;
				query?: string;
				channel?: string;
				target?: string;
				user?: string;
				emoji?: string;
				from?: string;
				with?: string;
				after?: string;
				before?: string;
				limit?: number;
			};
			let label = theme.fg("toolTitle", theme.bold("slack "));
			label += a.action ?? "?";

			// Search actions: show the assembled query (includes all params).
			// Non-search actions: show individual params.
			if (a.action?.startsWith("search")) {
				const queryParts = assembleQueryPreview(a);
				if (queryParts) {
					label += theme.fg("dim", ` "${queryParts}"`);
				}
			} else {
				if (a.query) {
					const preview =
						a.query.length > 40 ? `${a.query.slice(0, 40)}…` : a.query;
					label += theme.fg("dim", ` "${preview}"`);
				}
				if (a.channel) {
					const looksLikeId = /^[CDGW][A-Z0-9]+$/.test(a.channel);
					const ch = looksLikeId
						? a.channel
						: a.channel.startsWith("#")
							? a.channel
							: `#${a.channel}`;
					label += theme.fg("dim", ` ${ch}`);
				}
				if (a.user) {
					const handle = a.user.startsWith("@") ? a.user : `@${a.user}`;
					label += theme.fg("dim", ` ${handle}`);
				}
				if (a.emoji) {
					label += theme.fg("dim", ` :${a.emoji}:`);
				}
				if (a.target) {
					const parsed = parseSlackUrl(a.target);
					if (parsed) {
						label += theme.fg("dim", ` ${parsed.channel} ${parsed.ts}`);
					}
				}
			}

			return new Text(label, 0, 0);
		},

		renderResult(result, options, theme) {
			const textContent = result.content?.[0]?.text || "";
			const d = result.details as Record<string, unknown> | undefined;

			// Errors
			if (
				textContent.startsWith("Slack API error:") ||
				textContent.startsWith("⚠️") ||
				textContent.startsWith("Missing required")
			) {
				const preview =
					textContent.length > 100
						? `${textContent.slice(0, 100)}…`
						: textContent;
				return new Text(theme.fg("error", preview), 0, 0);
			}

			// Cancellations
			if (textContent.startsWith("✗")) {
				return new Text(theme.fg("warning", textContent), 0, 0);
			}

			// Write successes
			if (textContent.startsWith("✓")) {
				return new Text(theme.fg("success", textContent.split("\n")[0]), 0, 0);
			}

			// Search results (messages or files)
			if (d?.total !== undefined) {
				const total = d.total as number;
				const msgs = d.messages as MessagePreview[] | undefined;
				const files = d.files as FilePreview[] | undefined;

				if (msgs?.length) {
					const summary = theme.fg("success", `✓ ${total} messages`);
					const previews = renderMessagePreviews(msgs, theme);
					if (!options.expanded) {
						return new Text(`${summary}\n${previews}`, 0, 0);
					}
					return new Text(`${summary}\n${textContent}`, 0, 0);
				}

				if (files?.length) {
					const summary = theme.fg("success", `✓ ${total} files`);
					const previews = files
						.slice(0, MAX_PREVIEWS)
						.map((f) => `  ${theme.fg("dim", f.name || "untitled")}`)
						.join("\n");
					if (!options.expanded) {
						return new Text(`${summary}\n${previews}`, 0, 0);
					}
					return new Text(`${summary}\n${textContent}`, 0, 0);
				}

				return new Text(theme.fg("success", `✓ ${total} results`), 0, 0);
			}

			// Thread or message list
			if (Array.isArray(d?.messages)) {
				const msgs = d.messages as MessagePreview[];
				const summary = theme.fg("success", `✓ ${msgs.length} message(s)`);
				const previews = renderMessagePreviews(msgs, theme);
				if (!options.expanded) {
					return new Text(`${summary}\n${previews}`, 0, 0);
				}
				return new Text(`${summary}\n${textContent}`, 0, 0);
			}

			// Single user
			if (d?.user) {
				const u = d.user as UserPreview;
				const name = u.displayName || u.realName || u.name || "?";
				const title = u.title ? theme.fg("dim", ` — ${u.title}`) : "";
				return new Text(
					`${theme.fg("success", "✓")} @${u.name}${title} (${name})`,
					0,
					0,
				);
			}

			// Single channel
			if (d?.channel) {
				const ch = d.channel as ChannelPreview;
				const members = ch.memberCount
					? theme.fg("dim", ` (${ch.memberCount} members)`)
					: "";
				const topic = ch.topic
					? `\n  ${theme.fg("dim", truncateText(ch.topic, 60))}`
					: "";
				return new Text(
					`${theme.fg("success", "✓")} #${ch.name}${members}${topic}`,
					0,
					0,
				);
			}

			// Single message
			if (d?.message) {
				const m = d.message as MessagePreview;
				const who = resolveUser(m.user);
				const snippet = truncateText(formatSlackText(m.text || ""), 60);
				return new Text(
					`${theme.fg("success", "✓")} ${theme.fg("dim", who)}: ${snippet}`,
					0,
					0,
				);
			}

			// Reactions
			if (d?.reactions) {
				return new Text(theme.fg("success", "✓ reactions"), 0, 0);
			}

			// Fallback
			return new Text(theme.fg("success", "✓"), 0, 0);
		},
	});

	pi.registerCommand("slack-setup", {
		description: "Set up Slack authentication (interactive)",
		handler: async (args, ctx) => {
			await handleSlackAuthCommand(args, ctx, ENV_OAUTH_CONFIG);
		},
	});

	pi.registerCommand("slack-auth", {
		description:
			"Authenticate with Slack. Usage: slack-auth [--status] [--logout]",
		handler: async (args, ctx) => {
			await handleSlackAuthCommand(args, ctx, ENV_OAUTH_CONFIG);
		},
	});

	pi.registerCommand("slack-reset", {
		description:
			"Clear all Slack configuration (OAuth credentials, tokens). " +
			"Used for testing or starting fresh.",
		handler: async (_args, ctx) => {
			clearAllConfig();
			cachedClient = null;
			ctx.ui.notify(
				"✓ Cleared all Slack configuration. Run /slack-setup to start fresh.",
				"info",
			);
		},
	});
}

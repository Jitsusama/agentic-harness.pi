/**
 * Routes incoming Slack tool actions to the appropriate
 * API handlers.
 *
 * Each action maps to a handler via a registry. Handlers
 * receive the Slack client, raw params, and extension context.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getChannelInfo } from "./api/channels.js";
import type { SlackClient } from "./api/client.js";
import {
	getMessage,
	getThread,
	listMessages,
	replyToThread,
	sendMessage,
} from "./api/messages.js";
import {
	addReaction,
	getReactions,
	listReactions,
	removeReaction,
} from "./api/reactions.js";
import {
	refreshDmNames,
	resolveChannelsInMessages,
} from "./api/resolve-channels.js";
import { searchFiles, searchMessages } from "./api/search.js";
import { getUserInfo } from "./api/users.js";
import {
	confirmReaction,
	confirmReply,
	confirmSendMessage,
} from "./confirmation.js";
import { renderChannel } from "./renderers/channel.js";
import {
	renderMessage,
	renderMessageList,
	renderThread,
} from "./renderers/message.js";
import {
	renderMessageReactions,
	renderReactedMessages,
} from "./renderers/reactions.js";
import { renderFileList } from "./renderers/search.js";
import { renderUser } from "./renderers/user.js";
import { resolveChannel } from "./resolvers/channel.js";
import { resolveTarget } from "./resolvers/target.js";
import { resolveUser } from "./resolvers/user.js";
import {
	type ActionParams,
	numberParam,
	stringParam,
	type ToolResult,
} from "./types.js";

/** Handler function that processes a Slack action. */
type ActionHandler = (
	client: SlackClient,
	params: ActionParams,
	ctx: ExtensionContext,
) => Promise<ToolResult>;

/** Route a tool action to the appropriate handler. */
export async function routeAction(
	action: string,
	client: SlackClient,
	params: ActionParams,
	ctx: ExtensionContext,
): Promise<ToolResult> {
	const handler = ACTION_HANDLERS.get(action);
	if (!handler) {
		return text(`Unknown action: ${action}`);
	}
	return handler(client, params, ctx);
}

/** Shorthand for a simple text result. */
function text(content: string, details?: unknown): ToolResult {
	return { content: [{ type: "text", text: content }], details };
}

/** Shorthand for missing parameter errors. */
function missing(param: string): ToolResult {
	return text(`Missing required parameter: ${param}`);
}

/**
 * Fall back to `*` when no explicit query is given but
 * structured search params (from, with, channel, after,
 * before) are present. Lets agents omit `query` when
 * filtering by operator alone.
 */
function defaultQuery(params: ActionParams): string | undefined {
	const hasOperator =
		stringParam(params, "from") ||
		stringParam(params, "with") ||
		stringParam(params, "channel") ||
		stringParam(params, "after") ||
		stringParam(params, "before");
	return hasOperator ? "*" : undefined;
}

// ── Read handlers ───────────────────────────────────────

async function handleSearchMessages(
	client: SlackClient,
	params: ActionParams,
): Promise<ToolResult> {
	const query = stringParam(params, "query") ?? defaultQuery(params);
	if (!query) return missing("query");

	const result = await searchMessages(client, query, {
		channel: stringParam(params, "channel"),
		from: stringParam(params, "from"),
		with: stringParam(params, "with"),
		after: stringParam(params, "after"),
		before: stringParam(params, "before"),
		limit: numberParam(params, "limit"),
	});

	// Resolve channel kinds (DM, group DM, channel) for search
	// results. Search gives us names but not types.
	await resolveChannelsInMessages(client, result.messages);
	refreshDmNames(result.messages);

	return text(renderMessageList(result.messages, result.total, result.query), {
		messages: result.messages,
		total: result.total,
		query: result.query,
	});
}

async function handleSearchFiles(
	client: SlackClient,
	params: ActionParams,
): Promise<ToolResult> {
	const query = stringParam(params, "query") ?? defaultQuery(params);
	if (!query) return missing("query");

	const result = await searchFiles(client, query, {
		channel: stringParam(params, "channel"),
		from: stringParam(params, "from"),
		with: stringParam(params, "with"),
		after: stringParam(params, "after"),
		before: stringParam(params, "before"),
		type: stringParam(params, "type"),
		limit: numberParam(params, "limit"),
	});

	return text(renderFileList(result.files, result.total, result.query), {
		files: result.files,
		total: result.total,
		query: result.query,
	});
}

async function handleGetMessage(
	client: SlackClient,
	params: ActionParams,
): Promise<ToolResult> {
	const { channel, ts } = await resolveTarget(
		client,
		stringParam(params, "target"),
		stringParam(params, "channel"),
		stringParam(params, "ts"),
	);

	const msg = await getMessage(client, channel, ts);
	return text(renderMessage(msg), { message: msg });
}

async function handleGetThread(
	client: SlackClient,
	params: ActionParams,
): Promise<ToolResult> {
	const { channel, ts } = await resolveTarget(
		client,
		stringParam(params, "target"),
		stringParam(params, "channel"),
		stringParam(params, "ts"),
	);

	const messages = await getThread(
		client,
		channel,
		ts,
		numberParam(params, "limit"),
	);
	return text(renderThread(messages), { messages });
}

async function handleListMessages(
	client: SlackClient,
	params: ActionParams,
): Promise<ToolResult> {
	const channelInput = stringParam(params, "channel");
	if (!channelInput) return missing("channel");

	const channel = await resolveChannel(client, channelInput);
	const messages = await listMessages(client, channel, {
		limit: numberParam(params, "limit"),
		oldest: stringParam(params, "oldest"),
		latest: stringParam(params, "latest"),
	});

	return text(renderMessageList(messages), { messages });
}

async function handleGetChannel(
	client: SlackClient,
	params: ActionParams,
): Promise<ToolResult> {
	const channelInput = stringParam(params, "channel");
	if (!channelInput) return missing("channel");

	const channelId = await resolveChannel(client, channelInput);
	const info = await getChannelInfo(client, channelId);
	return text(renderChannel(info), { channel: info });
}

async function handleGetUser(
	client: SlackClient,
	params: ActionParams,
): Promise<ToolResult> {
	const userInput = stringParam(params, "user");
	if (!userInput) return missing("user");

	const userId = await resolveUser(client, userInput);
	const info = await getUserInfo(client, userId);
	return text(renderUser(info), { user: info });
}

async function handleListReactions(
	client: SlackClient,
	params: ActionParams,
): Promise<ToolResult> {
	const messages = await listReactions(client, {
		user: stringParam(params, "user"),
		limit: numberParam(params, "limit"),
	});
	return text(renderReactedMessages(messages), { messages });
}

async function handleGetReactions(
	client: SlackClient,
	params: ActionParams,
): Promise<ToolResult> {
	const { channel, ts } = await resolveTarget(
		client,
		stringParam(params, "target"),
		stringParam(params, "channel"),
		stringParam(params, "ts"),
	);

	const data = await getReactions(client, channel, ts);
	return text(renderMessageReactions(data), { reactions: data });
}

// ── Write handlers (with confirmation gates) ────────────

async function handleSendMessage(
	client: SlackClient,
	params: ActionParams,
	ctx: ExtensionContext,
): Promise<ToolResult> {
	const channelInput = stringParam(params, "channel");
	const msgText = stringParam(params, "text");
	if (!channelInput) return missing("channel");
	if (!msgText) return missing("text");

	const channel = await resolveChannel(client, channelInput);

	const confirmed = await confirmSendMessage(ctx, channel, msgText);
	if (!confirmed) return text("✗ Send message cancelled.");
	if (!confirmed.approved) return text(confirmed.redirect);

	const result = await sendMessage(client, channel, confirmed.data.text);
	return text(`✓ Message sent to ${channel} (ts: ${result.ts})`, result);
}

async function handleReplyToThread(
	client: SlackClient,
	params: ActionParams,
	ctx: ExtensionContext,
): Promise<ToolResult> {
	const { channel, ts } = await resolveTarget(
		client,
		stringParam(params, "target"),
		stringParam(params, "channel"),
		stringParam(params, "ts"),
	);
	const msgText = stringParam(params, "text");
	if (!msgText) return missing("text");

	const confirmed = await confirmReply(ctx, channel, ts, msgText);
	if (!confirmed) return text("✗ Reply cancelled.");
	if (!confirmed.approved) return text(confirmed.redirect);

	const result = await replyToThread(client, channel, ts, confirmed.data.text);
	return text(`✓ Reply sent in thread ${ts} (ts: ${result.ts})`, result);
}

async function handleAddReaction(
	client: SlackClient,
	params: ActionParams,
	ctx: ExtensionContext,
): Promise<ToolResult> {
	const { channel, ts } = await resolveTarget(
		client,
		stringParam(params, "target"),
		stringParam(params, "channel"),
		stringParam(params, "ts"),
	);
	const emoji = stringParam(params, "emoji");
	if (!emoji) return missing("emoji");

	const confirmed = await confirmReaction(ctx, channel, ts, emoji, "add");
	if (!confirmed) return text("✗ Reaction cancelled.");
	if (!confirmed.approved) return text(confirmed.redirect);

	await addReaction(client, channel, ts, emoji);
	return text(`✓ Added :${emoji}: reaction`);
}

async function handleRemoveReaction(
	client: SlackClient,
	params: ActionParams,
	ctx: ExtensionContext,
): Promise<ToolResult> {
	const { channel, ts } = await resolveTarget(
		client,
		stringParam(params, "target"),
		stringParam(params, "channel"),
		stringParam(params, "ts"),
	);
	const emoji = stringParam(params, "emoji");
	if (!emoji) return missing("emoji");

	const confirmed = await confirmReaction(ctx, channel, ts, emoji, "remove");
	if (!confirmed) return text("✗ Reaction removal cancelled.");
	if (!confirmed.approved) return text(confirmed.redirect);

	await removeReaction(client, channel, ts, emoji);
	return text(`✓ Removed :${emoji}: reaction`);
}

// ── Action registry ─────────────────────────────────────

const ACTION_HANDLERS = new Map<string, ActionHandler>([
	["search_messages", handleSearchMessages],
	["search_files", handleSearchFiles],
	["get_message", handleGetMessage],
	["get_thread", handleGetThread],
	["list_messages", handleListMessages],
	["get_channel", handleGetChannel],
	["get_user", handleGetUser],
	["list_reactions", handleListReactions],
	["get_reactions", handleGetReactions],
	["send_message", handleSendMessage],
	["reply_to_thread", handleReplyToThread],
	["add_reaction", handleAddReaction],
	["remove_reaction", handleRemoveReaction],
]);

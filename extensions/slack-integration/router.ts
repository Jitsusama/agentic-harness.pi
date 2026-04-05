/**
 * Routes incoming Slack tool actions to the appropriate
 * API handlers.
 *
 * Resolves all identifiers (channel, target, user) before
 * dispatching so handlers receive typed objects instead of
 * raw strings. Each action maps to a handler via a registry.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getChannelInfo } from "../../lib/slack/api/channels.js";
import type { SlackClient } from "../../lib/slack/api/client.js";
import {
	getMessage,
	getThread,
	listMessages,
	replyToThread,
	sendMessage,
} from "../../lib/slack/api/messages.js";
import {
	addReaction,
	getReactions,
	listReactions,
	removeReaction,
} from "../../lib/slack/api/reactions.js";
import { resolveMessages } from "../../lib/slack/api/resolve-messages.js";
import { searchFiles, searchMessages } from "../../lib/slack/api/search.js";
import { getUserInfo } from "../../lib/slack/api/users.js";
import { renderChannel } from "../../lib/slack/renderers/channel.js";
import {
	renderMessage,
	renderMessageList,
	renderThread,
} from "../../lib/slack/renderers/message.js";
import {
	renderMessageReactions,
	renderReactedMessages,
} from "../../lib/slack/renderers/reactions.js";
import { renderFileList } from "../../lib/slack/renderers/search.js";
import { renderUser } from "../../lib/slack/renderers/user.js";
import { resolveConversation } from "../../lib/slack/resolvers/conversation.js";
import { resolveTarget } from "../../lib/slack/resolvers/target.js";
import { resolveUser } from "../../lib/slack/resolvers/user.js";
import {
	type ActionParams,
	numberParam,
	type ResolvedParams,
	stringParam,
	type ToolResult,
} from "../../lib/slack/types.js";
import {
	confirmReaction,
	confirmReply,
	confirmSendMessage,
} from "./confirmation.js";

/** Handler function that processes a Slack action. */
type ActionHandler = (
	client: SlackClient,
	params: ActionParams,
	resolved: ResolvedParams,
	ctx: ExtensionContext,
) => Promise<ToolResult>;

/**
 * Route a tool action to the appropriate handler.
 *
 * Resolves all identifiers upfront, then dispatches to the
 * handler with both raw params and resolved types.
 */
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

	const resolved = await resolveAllParams(client, params);
	return handler(client, params, resolved, ctx);
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
 * Resolve all identifiers from raw tool parameters.
 *
 * Runs before every handler so they receive typed objects
 * instead of raw strings. Resolution errors (unknown channel,
 * bad URL) propagate as exceptions to the caller.
 */
async function resolveAllParams(
	client: SlackClient,
	params: ActionParams,
): Promise<ResolvedParams> {
	const resolved: ResolvedParams = {};

	const targetStr = stringParam(params, "target");
	const channelStr = stringParam(params, "channel");
	const tsStr = stringParam(params, "ts");
	const userStr = stringParam(params, "user");

	// Target (permalink or channel+ts) takes priority.
	if (targetStr || (channelStr && tsStr)) {
		try {
			resolved.target = await resolveTarget(
				client,
				targetStr,
				channelStr,
				tsStr,
			);
			resolved.conversation = resolved.target.conversation;
		} catch {
			// Target resolution failed. Fall through to channel-only
			// resolution if channel was provided without ts.
			if (channelStr && !tsStr) {
				resolved.conversation = await resolveConversation(client, channelStr);
			}
			// If target was explicitly provided and failed, re-throw.
			else if (targetStr) {
				throw new Error(
					"Could not parse the target URL. Provide a valid Slack permalink, " +
						"or use the channel and ts parameters instead.",
				);
			}
		}
	}
	// Channel without ts: conversation-only resolution.
	else if (channelStr) {
		resolved.conversation = await resolveConversation(client, channelStr);
	}

	// User resolution.
	if (userStr) {
		resolved.userId = await resolveUser(client, userStr);
	}

	return resolved;
}

/**
 * Coerce a timestamp parameter to Slack's epoch-seconds format.
 *
 * The agent often passes ISO date strings (e.g. "2026-01-27"
 * or "2026-01-27T00:00:00Z") for oldest/latest, but Slack's
 * conversations.history API expects Unix epoch seconds (e.g.
 * "1737936000"). This silently converts dates so the API
 * doesn't ignore them and return empty results.
 */
function coerceTimestamp(value: string | undefined): string | undefined {
	if (!value) return undefined;

	// Already a numeric timestamp (epoch seconds or Slack ts with decimals).
	if (/^\d+(\.\d+)?$/.test(value)) return value;

	// ISO date or datetime string: parse and convert to epoch seconds.
	const parsed = Date.parse(value);
	if (!Number.isNaN(parsed)) {
		return String(parsed / 1000);
	}

	// Unrecognised format: pass through and let Slack deal with it.
	return value;
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
	resolved: ResolvedParams,
): Promise<ToolResult> {
	const query = stringParam(params, "query") ?? defaultQuery(params);
	if (!query) return missing("query");

	// Validate: search doesn't support DM conversations.
	if (resolved.conversation) {
		const conv = resolved.conversation;
		if (conv.kind === "dm" || conv.kind === "group_dm") {
			return text(
				`Slack search doesn't support ${conv.kind === "dm" ? "DM" : "group DM"} conversations. ` +
					"Use `list_messages` with the user ID as the channel instead.",
			);
		}
	}

	const result = await searchMessages(client, query, {
		// Use the resolved channel name for the search operator.
		channel: resolved.conversation?.name ?? stringParam(params, "channel"),
		from: stringParam(params, "from"),
		with: stringParam(params, "with"),
		after: stringParam(params, "after"),
		before: stringParam(params, "before"),
		limit: numberParam(params, "limit"),
	});

	// Resolve users, conversations and channel mentions so
	// the rendered output shows handles instead of raw IDs.
	await resolveMessages(client, result.messages);

	return text(renderMessageList(result.messages, result.total, result.query), {
		messages: result.messages,
		total: result.total,
		query: result.query,
	});
}

async function handleSearchFiles(
	client: SlackClient,
	params: ActionParams,
	resolved: ResolvedParams,
): Promise<ToolResult> {
	const query = stringParam(params, "query") ?? defaultQuery(params);
	if (!query) return missing("query");

	// Validate: search doesn't support DM conversations.
	if (resolved.conversation) {
		const conv = resolved.conversation;
		if (conv.kind === "dm" || conv.kind === "group_dm") {
			return text(
				`Slack search doesn't support ${conv.kind === "dm" ? "DM" : "group DM"} conversations. ` +
					"Use `list_messages` with the user ID as the channel instead.",
			);
		}
	}

	const result = await searchFiles(client, query, {
		channel: resolved.conversation?.name ?? stringParam(params, "channel"),
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
	_client: SlackClient,
	_params: ActionParams,
	resolved: ResolvedParams,
): Promise<ToolResult> {
	if (!resolved.target) return missing("channel + ts or target");

	const msg = await getMessage(
		_client,
		resolved.target.conversation,
		resolved.target.ts,
	);
	await resolveMessages(_client, [msg]);
	return text(renderMessage(msg), { message: msg });
}

async function handleGetThread(
	client: SlackClient,
	params: ActionParams,
	resolved: ResolvedParams,
): Promise<ToolResult> {
	if (!resolved.target) return missing("channel + ts or target");

	const messages = await getThread(
		client,
		resolved.target.conversation,
		resolved.target.ts,
		numberParam(params, "limit"),
	);
	await resolveMessages(client, messages);
	return text(renderThread(messages), { messages });
}

async function handleListMessages(
	client: SlackClient,
	params: ActionParams,
	resolved: ResolvedParams,
): Promise<ToolResult> {
	if (!resolved.conversation) return missing("channel");

	const messages = await listMessages(client, resolved.conversation, {
		limit: numberParam(params, "limit"),
		oldest: coerceTimestamp(stringParam(params, "oldest")),
		latest: coerceTimestamp(stringParam(params, "latest")),
	});
	await resolveMessages(client, messages);

	return text(renderMessageList(messages), { messages });
}

async function handleGetChannel(
	client: SlackClient,
	_params: ActionParams,
	resolved: ResolvedParams,
): Promise<ToolResult> {
	if (!resolved.conversation) return missing("channel");

	const info = await getChannelInfo(client, resolved.conversation.id);
	return text(renderChannel(info), { channel: info });
}

async function handleGetUser(
	client: SlackClient,
	_params: ActionParams,
	resolved: ResolvedParams,
): Promise<ToolResult> {
	if (!resolved.userId) return missing("user");

	const info = await getUserInfo(client, resolved.userId);
	return text(renderUser(info), { user: info });
}

async function handleListReactions(
	client: SlackClient,
	params: ActionParams,
	resolved: ResolvedParams,
): Promise<ToolResult> {
	const messages = await listReactions(client, {
		user: resolved.userId ?? stringParam(params, "user"),
		limit: numberParam(params, "limit"),
	});
	return text(renderReactedMessages(messages), { messages });
}

async function handleGetReactions(
	client: SlackClient,
	_params: ActionParams,
	resolved: ResolvedParams,
): Promise<ToolResult> {
	if (!resolved.target) return missing("channel + ts or target");

	const data = await getReactions(
		client,
		resolved.target.conversation.id,
		resolved.target.ts,
	);
	return text(renderMessageReactions(data), { reactions: data });
}

// ── Write handlers (with confirmation gates) ────────────

async function handleSendMessage(
	client: SlackClient,
	params: ActionParams,
	resolved: ResolvedParams,
	ctx: ExtensionContext,
): Promise<ToolResult> {
	if (!resolved.conversation) return missing("channel");
	const msgText = stringParam(params, "text");
	if (!msgText) return missing("text");

	const displayName =
		resolved.conversation.displayName ?? resolved.conversation.id;
	const confirmed = await confirmSendMessage(ctx, displayName, msgText);
	if (!confirmed) return text("✗ Send message cancelled.");
	if (!confirmed.approved) return text(confirmed.redirect);

	const result = await sendMessage(
		client,
		resolved.conversation.id,
		confirmed.data.text,
	);
	return text(`✓ Message sent to ${displayName} (ts: ${result.ts})`, result);
}

async function handleReplyToThread(
	client: SlackClient,
	params: ActionParams,
	resolved: ResolvedParams,
	ctx: ExtensionContext,
): Promise<ToolResult> {
	if (!resolved.target) return missing("channel + ts or target");
	const msgText = stringParam(params, "text");
	if (!msgText) return missing("text");

	const displayName =
		resolved.target.conversation.displayName ?? resolved.target.conversation.id;
	const confirmed = await confirmReply(
		ctx,
		displayName,
		resolved.target.ts,
		msgText,
	);
	if (!confirmed) return text("✗ Reply cancelled.");
	if (!confirmed.approved) return text(confirmed.redirect);

	const result = await replyToThread(
		client,
		resolved.target.conversation.id,
		resolved.target.ts,
		confirmed.data.text,
	);
	return text(
		`✓ Reply sent in thread ${resolved.target.ts} (ts: ${result.ts})`,
		result,
	);
}

async function handleAddReaction(
	_client: SlackClient,
	params: ActionParams,
	resolved: ResolvedParams,
	ctx: ExtensionContext,
): Promise<ToolResult> {
	if (!resolved.target) return missing("channel + ts or target");
	const emoji = stringParam(params, "emoji");
	if (!emoji) return missing("emoji");

	const displayName =
		resolved.target.conversation.displayName ?? resolved.target.conversation.id;
	const confirmed = await confirmReaction(
		ctx,
		displayName,
		resolved.target.ts,
		emoji,
		"add",
	);
	if (!confirmed) return text("✗ Reaction cancelled.");
	if (!confirmed.approved) return text(confirmed.redirect);

	await addReaction(
		_client,
		resolved.target.conversation.id,
		resolved.target.ts,
		emoji,
	);
	return text(`✓ Added :${emoji}: reaction`);
}

async function handleRemoveReaction(
	_client: SlackClient,
	params: ActionParams,
	resolved: ResolvedParams,
	ctx: ExtensionContext,
): Promise<ToolResult> {
	if (!resolved.target) return missing("channel + ts or target");
	const emoji = stringParam(params, "emoji");
	if (!emoji) return missing("emoji");

	const displayName =
		resolved.target.conversation.displayName ?? resolved.target.conversation.id;
	const confirmed = await confirmReaction(
		ctx,
		displayName,
		resolved.target.ts,
		emoji,
		"remove",
	);
	if (!confirmed) return text("✗ Reaction removal cancelled.");
	if (!confirmed.approved) return text(confirmed.redirect);

	await removeReaction(
		_client,
		resolved.target.conversation.id,
		resolved.target.ts,
		emoji,
	);
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

/**
 * Slack conversations API: history, replies, and posting.
 *
 * Handles reading messages from channels, fetching threads,
 * and sending messages/replies.
 */

import { cacheUser, resolveUser } from "../resolvers/user.js";
import type {
	Conversation,
	SlackAttachment,
	SlackFile,
	SlackMessage,
	SlackReaction,
} from "../types.js";
import type { SlackClient } from "./client.js";
import {
	refreshDmNames,
	resolveConversationsInMessages,
} from "./resolve-conversations.js";
import { resolveUsersInMessages } from "./resolve-users.js";

/** Raw message shape from the Slack API. */
interface RawMessage {
	ts: string;
	user?: string;
	text?: string;
	thread_ts?: string;
	reply_count?: number;
	reactions?: Array<{ name: string; count: number; users: string[] }>;
	attachments?: Array<{
		title?: string;
		text?: string;
		fallback?: string;
		from_url?: string;
		image_url?: string;
	}>;
	files?: Array<{
		name: string;
		mimetype?: string;
		url_private?: string;
		permalink?: string;
	}>;
	permalink?: string;
	username?: string;
}

/** Convert a raw API message to our domain type. */
function toSlackMessage(
	msg: RawMessage,
	conversation?: Conversation,
): SlackMessage {
	if (msg.user && msg.username) {
		cacheUser(msg.username, msg.user);
	}

	const attachments: SlackAttachment[] | undefined = msg.attachments?.length
		? msg.attachments.map((a) => ({
				title: a.title,
				text: a.text,
				fallback: a.fallback,
				fromUrl: a.from_url,
				imageUrl: a.image_url,
			}))
		: undefined;

	const files: SlackFile[] | undefined = msg.files?.length
		? msg.files.map((f) => ({
				name: f.name,
				mimetype: f.mimetype,
				url: f.url_private || f.permalink,
			}))
		: undefined;

	// A message is a thread parent when its threadTs equals its own ts.
	// Messages without threadTs are top-level posts (not in any thread).
	const isThreadParent =
		msg.thread_ts !== undefined && msg.thread_ts === msg.ts;

	return {
		ts: msg.ts,
		text: msg.text ?? "",
		user: msg.user,
		conversation,
		threadTs: msg.thread_ts,
		replyCount: msg.reply_count,
		isThreadParent,
		reactions: msg.reactions as SlackReaction[] | undefined,
		attachments,
		files,
		permalink: msg.permalink,
	};
}

/**
 * Fetch a single message by channel and timestamp.
 *
 * Uses conversations.history with inclusive bounds to get
 * exactly one message. Attempts to fetch a permalink as well.
 */
export async function getMessage(
	client: SlackClient,
	conversation: Conversation,
	ts: string,
	signal?: AbortSignal,
): Promise<SlackMessage> {
	const response = await client.call<{
		messages: RawMessage[];
	}>(
		"conversations.history",
		{
			channel: conversation.id,
			latest: ts,
			oldest: ts,
			limit: 1,
			inclusive: true,
		},
		signal,
	);

	const msg = response.messages?.[0];
	if (!msg) {
		throw new Error("Message not found.");
	}

	// Best-effort permalink fetch.
	try {
		const linkResponse = await client.call<{ permalink: string }>(
			"chat.getPermalink",
			{ channel: conversation.id, message_ts: ts },
			signal,
		);
		msg.permalink = linkResponse.permalink;
	} catch {
		// Permalink is non-critical.
	}

	const result = toSlackMessage(msg, conversation);
	await resolveUsersInMessages(client, [result], signal);
	await resolveConversationsInMessages(client, [result], signal);
	refreshDmNames([result]);
	return result;
}

/** Maximum results per page for conversations.history. */
const MAX_HISTORY_PER_PAGE = 200;

/** Default number of messages when no limit is specified. */
const DEFAULT_HISTORY_LIMIT = 20;

/**
 * List recent messages in a channel with automatic pagination.
 *
 * Uses conversations.history with cursor-based pagination.
 * Pass `limit: 0` for unlimited. Returns messages in reverse
 * chronological order (newest first).
 */
export async function listMessages(
	client: SlackClient,
	conversation: Conversation,
	opts: { limit?: number; oldest?: string; latest?: string } = {},
	signal?: AbortSignal,
): Promise<SlackMessage[]> {
	const targetLimit =
		opts.limit === 0 ? undefined : opts.limit || DEFAULT_HISTORY_LIMIT;
	const perPage = targetLimit
		? Math.min(targetLimit, MAX_HISTORY_PER_PAGE)
		: MAX_HISTORY_PER_PAGE;

	const raw = await client.paginate<RawMessage>(
		"conversations.history",
		{
			channel: conversation.id,
			limit: perPage,
			oldest: opts.oldest,
			latest: opts.latest,
		},
		(r) => ((r as { messages?: RawMessage[] }).messages ?? []) as RawMessage[],
		targetLimit,
		signal,
	);

	const results = raw.map((m) => toSlackMessage(m, conversation));
	await resolveUsersInMessages(client, results, signal);
	await resolveConversationsInMessages(client, results, signal);
	refreshDmNames(results);
	return results;
}

/**
 * Fetch all replies in a thread.
 *
 * Auto-paginates using cursor until all messages are collected
 * or the limit is reached.
 */
export async function getThread(
	client: SlackClient,
	conversation: Conversation,
	threadTs: string,
	limit?: number,
	signal?: AbortSignal,
): Promise<SlackMessage[]> {
	const maxResults = limit || 100;

	const messages = await client.paginate<RawMessage>(
		"conversations.replies",
		{
			channel: conversation.id,
			ts: threadTs,
			limit: Math.min(maxResults, 200),
		},
		(r) => (r.messages ?? []) as RawMessage[],
		maxResults,
		signal,
	);

	const results = messages.map((m) => toSlackMessage(m, conversation));
	await resolveUsersInMessages(client, results, signal);
	await resolveConversationsInMessages(client, results, signal);
	refreshDmNames(results);
	return results;
}

/** Result from sending a message. */
export interface SendResult {
	ok: boolean;
	/** The conversation ID the message was posted to. */
	channel: string;
	ts: string;
}

/**
 * Pattern matching @handle mentions in outgoing message text.
 *
 * Matches `@word.word` patterns (e.g. @franck.delache) that
 * aren't already inside Slack's `<@U...>` syntax. Handles
 * may contain dots, hyphens and underscores.
 */
const OUTGOING_MENTION_PATTERN = /(?<![<@\w])@([\w][\w.-]+[\w])/g;

/**
 * Convert @handle mentions to Slack's `<@USER_ID>` format.
 *
 * Resolves each @handle via the user resolver (cache first,
 * API fallback). Handles that can't be resolved are left as
 * plain text so the message still sends.
 */
async function formatMentions(
	client: SlackClient,
	text: string,
	signal?: AbortSignal,
): Promise<string> {
	const matches = [...text.matchAll(OUTGOING_MENTION_PATTERN)];
	if (matches.length === 0) return text;

	// Deduplicate handles to avoid resolving the same one twice.
	const uniqueHandles = [...new Set(matches.map((m) => m[1]))];
	const resolved = new Map<string, string>();

	for (const handle of uniqueHandles) {
		try {
			const userId = await resolveUser(client, handle, signal);
			resolved.set(handle, userId);
		} catch {
			// Handle couldn't be resolved. Leave it as plain text.
		}
	}

	if (resolved.size === 0) return text;

	return text.replace(OUTGOING_MENTION_PATTERN, (_match, handle: string) => {
		const userId = resolved.get(handle);
		return userId ? `<@${userId}>` : `@${handle}`;
	});
}

/**
 * Send a message to a channel.
 */
export async function sendMessage(
	client: SlackClient,
	conversationId: string,
	text: string,
	signal?: AbortSignal,
): Promise<SendResult> {
	const formatted = await formatMentions(client, text, signal);
	const response = await client.call<{
		channel: string;
		ts: string;
	}>("chat.postMessage", { channel: conversationId, text: formatted }, signal);

	return {
		ok: true,
		channel: response.channel,
		ts: response.ts,
	};
}

/**
 * Reply to a thread.
 */
export async function replyToThread(
	client: SlackClient,
	conversationId: string,
	threadTs: string,
	text: string,
	signal?: AbortSignal,
): Promise<SendResult> {
	const formatted = await formatMentions(client, text, signal);
	const response = await client.call<{
		channel: string;
		ts: string;
	}>(
		"chat.postMessage",
		{ channel: conversationId, text: formatted, thread_ts: threadTs },
		signal,
	);

	return {
		ok: true,
		channel: response.channel,
		ts: response.ts,
	};
}

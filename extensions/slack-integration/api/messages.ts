/**
 * Slack conversations API: history, replies, and posting.
 *
 * Handles reading messages from channels, fetching threads,
 * and sending messages/replies.
 */

import { cacheUser } from "../resolvers/user.js";
import type { SlackMessage, SlackReaction } from "../types.js";
import type { SlackClient } from "./client.js";

/** Raw message shape from the Slack API. */
interface RawMessage {
	ts: string;
	user?: string;
	text?: string;
	thread_ts?: string;
	reply_count?: number;
	reactions?: Array<{ name: string; count: number; users: string[] }>;
	permalink?: string;
	username?: string;
}

/** Convert a raw API message to our domain type. */
function toSlackMessage(msg: RawMessage, channel?: string): SlackMessage {
	if (msg.user && msg.username) {
		cacheUser(msg.username, msg.user);
	}

	return {
		ts: msg.ts,
		text: msg.text ?? "",
		user: msg.user,
		channel,
		threadTs: msg.thread_ts,
		replyCount: msg.reply_count,
		reactions: msg.reactions as SlackReaction[] | undefined,
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
	channel: string,
	ts: string,
	signal?: AbortSignal,
): Promise<SlackMessage> {
	const response = await client.call<{
		messages: RawMessage[];
	}>(
		"conversations.history",
		{ channel, latest: ts, oldest: ts, limit: 1, inclusive: true },
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
			{ channel, message_ts: ts },
			signal,
		);
		msg.permalink = linkResponse.permalink;
	} catch {
		// Permalink is non-critical.
	}

	return toSlackMessage(msg, channel);
}

/**
 * List recent messages in a channel.
 *
 * Returns messages in reverse chronological order (newest first).
 */
export async function listMessages(
	client: SlackClient,
	channel: string,
	opts: { limit?: number; oldest?: string; latest?: string } = {},
	signal?: AbortSignal,
): Promise<SlackMessage[]> {
	const limit = Math.min(opts.limit || 20, 200);

	const response = await client.call<{
		messages: RawMessage[];
	}>(
		"conversations.history",
		{ channel, limit, oldest: opts.oldest, latest: opts.latest },
		signal,
	);

	return (response.messages ?? []).map((m) => toSlackMessage(m, channel));
}

/**
 * Fetch all replies in a thread.
 *
 * Auto-paginates using cursor until all messages are collected
 * or the limit is reached.
 */
export async function getThread(
	client: SlackClient,
	channel: string,
	threadTs: string,
	limit?: number,
	signal?: AbortSignal,
): Promise<SlackMessage[]> {
	const maxResults = limit || 100;

	const messages = await client.paginate<RawMessage>(
		"conversations.replies",
		{
			channel,
			ts: threadTs,
			limit: Math.min(maxResults, 200),
		},
		(r) => (r.messages ?? []) as RawMessage[],
		maxResults,
		signal,
	);

	return messages.map((m) => toSlackMessage(m, channel));
}

/** Result from sending a message. */
export interface SendResult {
	ok: boolean;
	channel: string;
	ts: string;
}

/**
 * Send a message to a channel.
 */
export async function sendMessage(
	client: SlackClient,
	channel: string,
	text: string,
	signal?: AbortSignal,
): Promise<SendResult> {
	const response = await client.call<{
		channel: string;
		ts: string;
	}>("chat.postMessage", { channel, text }, signal);

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
	channel: string,
	threadTs: string,
	text: string,
	signal?: AbortSignal,
): Promise<SendResult> {
	const response = await client.call<{
		channel: string;
		ts: string;
	}>("chat.postMessage", { channel, text, thread_ts: threadTs }, signal);

	return {
		ok: true,
		channel: response.channel,
		ts: response.ts,
	};
}

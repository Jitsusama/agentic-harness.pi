/**
 * Slack conversations API: history, replies, and posting.
 *
 * Handles reading messages from channels, fetching threads,
 * and sending messages/replies.
 */

import { cacheUser } from "../resolvers/user.js";
import type {
	SlackAttachment,
	SlackFile,
	SlackMessage,
	SlackReaction,
} from "../types.js";
import type { SlackClient } from "./client.js";
import {
	refreshDmNames,
	resolveChannelsInMessages,
} from "./resolve-channels.js";
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
function toSlackMessage(msg: RawMessage, channel?: string): SlackMessage {
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
		channel,
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

	const result = toSlackMessage(msg, channel);
	await resolveUsersInMessages(client, [result], signal);
	await resolveChannelsInMessages(client, [result], signal);
	refreshDmNames([result]);
	return result;
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

	const results = (response.messages ?? []).map((m) =>
		toSlackMessage(m, channel),
	);
	await resolveUsersInMessages(client, results, signal);
	await resolveChannelsInMessages(client, results, signal);
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

	const results = messages.map((m) => toSlackMessage(m, channel));
	await resolveUsersInMessages(client, results, signal);
	await resolveChannelsInMessages(client, results, signal);
	refreshDmNames(results);
	return results;
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

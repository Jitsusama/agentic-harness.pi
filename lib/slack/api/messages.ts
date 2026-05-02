/**
 * Slack conversations API: history, replies, and posting.
 *
 * Handles reading messages from channels, fetching threads,
 * and sending messages/replies.
 */

import { extractTables } from "../blocks.js";
import { lookupId } from "../resolvers/cache.js";
import { cacheUser, resolveUser } from "../resolvers/user.js";

/** Cache filename used by the user resolver. */
const USER_CACHE_FILE = "users.json";

import type {
	Conversation,
	MessageTarget,
	SlackAttachment,
	SlackFile,
	SlackMessage,
	SlackReaction,
} from "../types.js";
import type { SlackClient } from "./client.js";

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
		blocks?: unknown[];
	}>;
	files?: Array<{
		name: string;
		mimetype?: string;
		url_private?: string;
		permalink?: string;
	}>;
	blocks?: unknown[];
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

	// Extract tables from Block Kit blocks. Tables can live
	// in top-level blocks (sent via chat.postMessage) or inside
	// attachments[].blocks (created in Slack's WYSIWYG editor).
	const allBlocks: unknown[] = [];
	if (msg.blocks?.length) {
		allBlocks.push(...msg.blocks);
	}
	if (msg.attachments?.length) {
		for (const att of msg.attachments) {
			if (att.blocks?.length) {
				allBlocks.push(...att.blocks);
			}
		}
	}
	const tables = allBlocks.length ? extractTables(allBlocks) : undefined;

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
		tables: tables?.length ? tables : undefined,
		permalink: msg.permalink,
	};
}

/** Options for fetching a single message. */
export interface GetMessageOptions {
	signal?: AbortSignal;
}

/**
 * Fetch a single message by target.
 *
 * For top-level messages, pass a target with `ts`.
 * For thread replies, include `threadTs` in the target.
 * Uses conversations.history for top-level messages and
 * conversations.replies for thread replies.
 */
export async function getMessage(
	client: SlackClient,
	target: MessageTarget,
	opts?: GetMessageOptions,
): Promise<SlackMessage> {
	const { conversation, ts, threadTs } = target;
	let msg: RawMessage | undefined;

	if (threadTs) {
		// Fetch a specific thread reply: threadTs is the parent,
		// ts is the reply we want.
		const response = await client.call<{
			messages: RawMessage[];
		}>(
			"conversations.replies",
			{
				channel: conversation.id,
				ts: threadTs,
				latest: ts,
				oldest: ts,
				limit: 1,
				inclusive: true,
			},
			opts?.signal,
		);
		// Slack may include the thread parent alongside the
		// targeted reply; find the exact message we asked for.
		msg = response.messages?.find((m) => m.ts === ts);
	} else {
		// Fetch a top-level channel message.
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
			opts?.signal,
		);
		msg = response.messages?.[0];
	}

	if (!msg) {
		throw new Error("Message not found.");
	}

	// Best-effort permalink fetch.
	try {
		const linkResponse = await client.call<{ permalink: string }>(
			"chat.getPermalink",
			{ channel: conversation.id, message_ts: ts },
			opts?.signal,
		);
		msg.permalink = linkResponse.permalink;
	} catch {
		// Permalink is non-critical.
	}

	return toSlackMessage(msg, conversation);
}

/** Maximum results per page for conversations.history. */
const MAX_HISTORY_PER_PAGE = 200;

/** Default number of messages when no limit is specified. */
const DEFAULT_HISTORY_LIMIT = 20;

/** Options for listing channel history. */
export interface ListMessagesOptions {
	limit?: number;
	oldest?: string;
	latest?: string;
	signal?: AbortSignal;
}

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
	opts: ListMessagesOptions = {},
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
		opts.signal,
	);

	return raw.map((m) => toSlackMessage(m, conversation));
}

/** Options for fetching a thread. */
export interface GetThreadOptions {
	limit?: number;
	signal?: AbortSignal;
}

/**
 * Fetch all replies in a thread.
 *
 * The target's `ts` identifies the thread parent message.
 * Auto-paginates using cursor until all messages are
 * collected or the limit is reached.
 */
export async function getThread(
	client: SlackClient,
	target: MessageTarget,
	opts?: GetThreadOptions,
): Promise<SlackMessage[]> {
	const { conversation, ts } = target;
	const maxResults = opts?.limit || 100;

	const messages = await client.paginate<RawMessage>(
		"conversations.replies",
		{
			channel: conversation.id,
			ts,
			limit: Math.min(maxResults, 200),
		},
		(r) => (r.messages ?? []) as RawMessage[],
		maxResults,
		opts?.signal,
	);

	return messages.map((m) => toSlackMessage(m, conversation));
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
 * Matches any @word pattern that isn't already inside Slack's
 * `<@U...>` syntax. Handles may contain dots, hyphens and
 * underscores.
 */
const OUTGOING_MENTION_PATTERN = /(?<![<@\w])@([\w][\w.-]*[\w])/g;

/**
 * Slack broadcast keywords that use `<!keyword>` syntax
 * instead of `<@USER_ID>`.
 */
const SLACK_BROADCASTS = new Set(["here", "channel", "everyone"]);

/**
 * Convert @mentions in outgoing text to Slack's native syntax.
 *
 * Handles two kinds of mentions:
 * - Broadcast keywords (@here, @channel, @everyone) → `<!keyword>`
 * - User handles (@franck.delache) → `<@USER_ID>`
 *
 * User resolution strategy:
 * 1. Try the local user cache for every match (fast, no API)
 * 2. For multi-segment handles (contain a dot, like first.last),
 *    also try API resolution on cache miss
 * 3. Leave unresolved handles as plain text
 */
export async function formatMentions(
	client: SlackClient,
	text: string,
	signal?: AbortSignal,
): Promise<string> {
	const matches = [...text.matchAll(OUTGOING_MENTION_PATTERN)];
	if (matches.length === 0) return text;

	// Deduplicate handles to avoid resolving the same one twice.
	const uniqueHandles = [
		...new Set(
			matches.map((m) => m[1]).filter((h) => !SLACK_BROADCASTS.has(h)),
		),
	];
	const resolved = new Map<string, string>();

	for (const handle of uniqueHandles) {
		// Fast path: check the local cache (no API call).
		const cached = lookupId(USER_CACHE_FILE, handle);
		if (cached) {
			resolved.set(handle, cached);
			continue;
		}

		// API fallback: only for multi-segment handles (first.last)
		// to avoid spurious lookups for random @words in text.
		if (handle.includes(".")) {
			try {
				const userId = await resolveUser(client, handle, signal);
				resolved.set(handle, userId);
			} catch {
				// Handle couldn't be resolved. Leave as plain text.
			}
		}
	}

	return text.replace(OUTGOING_MENTION_PATTERN, (_match, handle: string) => {
		if (SLACK_BROADCASTS.has(handle)) return `<!${handle}>`;
		const userId = resolved.get(handle);
		return userId ? `<@${userId}>` : `@${handle}`;
	});
}

/**
 * Send a message to a channel.
 *
 * When `blocks` is provided, it's JSON-stringified and sent
 * as the `blocks` parameter to `chat.postMessage`. The `text`
 * field serves as the notification fallback.
 */
export async function sendMessage(
	client: SlackClient,
	conversationId: string,
	text: string,
	blocks?: unknown[],
	signal?: AbortSignal,
): Promise<SendResult> {
	const formatted = await formatMentions(client, text, signal);
	const params: Record<string, string | number | boolean | undefined> = {
		channel: conversationId,
		text: formatted,
	};
	if (blocks) {
		params.blocks = JSON.stringify(blocks);
	}
	const response = await client.call<{
		channel: string;
		ts: string;
	}>("chat.postMessage", params, signal);

	return {
		ok: true,
		channel: response.channel,
		ts: response.ts,
	};
}

/**
 * Edit an existing message.
 *
 * Calls `chat.update`. Slack only allows editing messages
 * the authenticated user authored, and it cannot change
 * file attachments — only the message's text and blocks.
 *
 * When `blocks` is provided, the previous blocks payload
 * is replaced wholesale. Pass `blocks: []` to clear blocks
 * and revert the message to plain text.
 */
export async function editMessage(
	client: SlackClient,
	conversationId: string,
	ts: string,
	text: string,
	blocks?: unknown[],
	signal?: AbortSignal,
): Promise<SendResult> {
	const formatted = await formatMentions(client, text, signal);
	const params: Record<string, string | number | boolean | undefined> = {
		channel: conversationId,
		ts,
		text: formatted,
	};
	if (blocks) {
		params.blocks = JSON.stringify(blocks);
	}
	const response = await client.call<{
		channel: string;
		ts: string;
	}>("chat.update", params, signal);

	return {
		ok: true,
		channel: response.channel,
		ts: response.ts,
	};
}

/**
 * Reply to a thread.
 *
 * When `blocks` is provided, it's JSON-stringified and sent
 * as the `blocks` parameter to `chat.postMessage`. The `text`
 * field serves as the notification fallback.
 */
export async function replyToThread(
	client: SlackClient,
	conversationId: string,
	threadTs: string,
	text: string,
	blocks?: unknown[],
	signal?: AbortSignal,
): Promise<SendResult> {
	const formatted = await formatMentions(client, text, signal);
	const params: Record<string, string | number | boolean | undefined> = {
		channel: conversationId,
		text: formatted,
		thread_ts: threadTs,
	};
	if (blocks) {
		params.blocks = JSON.stringify(blocks);
	}
	const response = await client.call<{
		channel: string;
		ts: string;
	}>("chat.postMessage", params, signal);

	return {
		ok: true,
		channel: response.channel,
		ts: response.ts,
	};
}

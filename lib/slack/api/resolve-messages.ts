/**
 * Unified message resolution: users, conversations and
 * channel mentions in one call.
 *
 * Composes resolveUsersInMessages, resolveConversationsInMessages
 * and refreshDmNames into a single entry point. Also resolves
 * channel IDs that only appear as text mentions (<#C123>),
 * which the per-message conversation resolver doesn't cover.
 *
 * Consumers call this after fetching messages and before
 * rendering. API functions (getMessage, getThread, etc.) do
 * free cache warming but no resolution — this function is
 * the explicit resolution step.
 */

import { lookupName } from "../resolvers/cache.js";
import { cacheChannelName } from "../resolvers/conversation.js";
import {
	fetchConversation,
	getCachedConversation,
} from "../resolvers/conversation-cache.js";
import type { SlackMessage } from "../types.js";
import type { SlackClient } from "./client.js";
import {
	refreshDmNames,
	resolveConversationsInMessages,
} from "./resolve-conversations.js";
import { resolveUsersInMessages } from "./resolve-users.js";

/** Cache filename for channel name ↔ ID lookups. */
const CHANNEL_CACHE_FILE = "channels.json";

/** Pattern matching channel mentions in Slack message text. */
const CHANNEL_MENTION_PATTERN = /<#([CDG][A-Z0-9]+)(?:\|[^>]*)?>/g;

/** Concurrency limit for conversations.info calls. */
const BATCH_SIZE = 20;

/**
 * Resolve all unknown entities in a list of messages.
 *
 * Handles three concerns in order:
 * 1. User IDs → display names (msg.user + <@U123> in text)
 * 2. Conversation IDs → metadata (msg.conversation.id)
 * 3. Channel mentions in text → cache warming (<#C123>)
 * 4. DM display name refresh (after user names are known)
 *
 * Mutates messages in place. Silently skips entities that
 * fail to resolve (deleted users, inaccessible channels).
 */
export async function resolveMessages(
	client: SlackClient,
	messages: SlackMessage[],
	signal?: AbortSignal,
): Promise<void> {
	// Users first — DM display names depend on resolved user handles.
	await resolveUsersInMessages(client, messages, signal);
	await resolveConversationsInMessages(client, messages, signal);

	// Channel mentions in text: <#C123> patterns that aren't
	// the message's own conversation. resolveConversationsInMessages
	// only resolves msg.conversation.id.
	await resolveChannelMentionsInText(client, messages, signal);

	// Refresh DM names last — user handles are now resolved.
	refreshDmNames(messages);
}

/**
 * Resolve channel IDs that appear only as text mentions.
 *
 * Scans all message text for <#C123> patterns, deduplicates,
 * and calls conversations.info for any that aren't in the
 * channel cache. This warms the file cache so formatSlackText
 * can resolve them without API calls.
 */
async function resolveChannelMentionsInText(
	client: SlackClient,
	messages: SlackMessage[],
	signal?: AbortSignal,
): Promise<void> {
	const unknownIds = new Set<string>();

	for (const msg of messages) {
		if (!msg.text) continue;
		for (const match of msg.text.matchAll(CHANNEL_MENTION_PATTERN)) {
			const channelId = match[1];
			// Skip if already in the file cache (survives across sessions).
			if (lookupName(CHANNEL_CACHE_FILE, channelId)) continue;
			// Skip if already in the session cache.
			if (getCachedConversation(channelId)) continue;
			unknownIds.add(channelId);
		}
	}

	if (unknownIds.size === 0) return;

	const ids = [...unknownIds];
	for (let i = 0; i < ids.length; i += BATCH_SIZE) {
		if (signal?.aborted) return;

		const batch = ids.slice(i, i + BATCH_SIZE);
		await Promise.all(
			batch.map(async (id) => {
				try {
					const conversation = await fetchConversation(client, id, signal);
					if (conversation.kind === "channel" && conversation.name) {
						cacheChannelName(conversation.name, conversation.id);
					}
				} catch {
					// Channel not found or inaccessible. Skip —
					// formatSlackText falls back to the raw ID.
				}
			}),
		);
	}
}

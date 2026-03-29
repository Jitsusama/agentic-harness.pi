/**
 * Batch conversation resolution for messages.
 *
 * After fetching messages from any API, this module resolves
 * conversation IDs to display names and determines the
 * conversation kind (channel, DM, group DM). This means the
 * renderers always show #channel-name, "@person", or
 * "@a, @b, @c" instead of raw IDs like C0AJY0FLK8Q.
 *
 * Uses the shared conversation cache to avoid redundant
 * conversations.info calls across the extension.
 */

import { cacheChannelName } from "../resolvers/conversation.js";
import {
	cacheConversation,
	fetchConversation,
	getCachedConversation,
	refreshCachedDmNames,
} from "../resolvers/conversation-cache.js";
import type { Conversation, SlackMessage } from "../types.js";
import type { SlackClient } from "./client.js";

/**
 * Resolve conversation metadata for all unique conversations
 * in a list of messages. Creates or enriches the Conversation
 * object on each message.
 *
 * Calls conversations.info for unknown conversations, caches
 * the results, and resolves DM partner names. Silently skips
 * conversations that fail to resolve.
 */
export async function resolveConversationsInMessages(
	client: SlackClient,
	messages: SlackMessage[],
	signal?: AbortSignal,
): Promise<void> {
	const unknownIds = new Set<string>();

	for (const msg of messages) {
		const id = msg.conversation?.id;
		if (id && !getCachedConversation(id)) {
			unknownIds.add(id);
		}
	}

	// Resolve unknown conversations via conversations.info.
	if (unknownIds.size > 0) {
		const ids = [...unknownIds];
		const BATCH_SIZE = 5;

		for (let i = 0; i < ids.length; i += BATCH_SIZE) {
			if (signal?.aborted) return;

			const batch = ids.slice(i, i + BATCH_SIZE);
			await Promise.all(
				batch.map(async (id) => {
					try {
						await fetchConversation(client, id, signal);
					} catch {
						// Conversation not found or inaccessible. Skip.
					}
				}),
			);
		}
	}

	// Apply resolved metadata to messages.
	for (const msg of messages) {
		const id = msg.conversation?.id;
		if (!id) continue;

		const cached = getCachedConversation(id);
		if (cached) {
			msg.conversation = cached;

			// Cache name → ID for cross-session persistence.
			if (cached.kind === "channel" && cached.name) {
				cacheChannelName(cached.name, cached.id);
			}
		}
	}
}

/**
 * Detect names that are actually user IDs.
 *
 * The search API returns user IDs as channel names for DM
 * channels (e.g. "U098TB6UXGA" instead of a readable name).
 * We must not cache these because they'd prevent proper
 * conversations.info resolution.
 */
function looksLikeUserId(name: string): boolean {
	return /^[UW][A-Z0-9]{8,}$/.test(name);
}

/**
 * Pre-populate the conversation cache from search results.
 *
 * Search results include channel name but not channel type.
 * This avoids conversations.info calls for channels we've
 * already seen names for, but those entries won't have
 * accurate kind until conversations.info runs.
 *
 * Skips names that look like user IDs (DM channels) — those
 * need conversations.info to resolve properly.
 */
export function cacheConversationFromSearch(
	channelId: string,
	name: string,
): void {
	if (getCachedConversation(channelId)) return;

	// DM channels report user IDs as names in search results.
	// Skip these so resolveConversationsInMessages can do a
	// proper conversations.info lookup.
	if (looksLikeUserId(name)) return;

	const isGroupDm = name.startsWith("mpdm-");
	const conversation: Conversation = {
		id: channelId,
		name: isGroupDm ? undefined : name,
		kind: isGroupDm ? "group_dm" : "channel",
		displayName: isGroupDm ? formatGroupDmName(name) : `#${name}`,
	};
	cacheConversation(conversation);
}

/**
 * Update DM conversation display names after user resolution.
 *
 * Call this after resolveUsersInMessages to refresh DM
 * display names with resolved @handles instead of raw IDs.
 */
export function refreshDmNames(messages: SlackMessage[]): void {
	refreshCachedDmNames();

	for (const msg of messages) {
		const id = msg.conversation?.id;
		if (!id) continue;

		const cached = getCachedConversation(id);
		if (cached) {
			msg.conversation = cached;
		}
	}
}

/**
 * Format a group DM name from the mpdm- format.
 * Slack names group DMs like `mpdm-user1--user2--user3-1`.
 */
function formatGroupDmName(rawName: string): string {
	const stripped = rawName.replace(/^mpdm-/, "").replace(/-\d+$/, "");
	const users = stripped.split("--").map((u) => `@${u}`);
	return users.join(", ");
}

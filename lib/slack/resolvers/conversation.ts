/**
 * Conversation resolver: any identifier → Conversation.
 *
 * Accepts channel IDs, user IDs, @-prefixed user handles,
 * #-prefixed channel names, bare channel names and Slack
 * URLs. Returns a Conversation with at least id and kind
 * populated. Uses the shared conversation cache to avoid
 * redundant API calls.
 *
 * The prefix determines intent: `@handle` resolves as a
 * user (opening the DM conversation), `#name` resolves as
 * a channel. IDs are detected by their Slack prefix pattern
 * (C/D/G for channels, U/W for users). Bare strings that
 * match none of these fall through to channel name search
 * as a last resort.
 *
 * On enterprise grids, conversations.list is blocked, so we
 * resolve channel names by searching for a message in that
 * channel and extracting the channel ID from the result.
 */

import type { SlackClient } from "../api/client.js";
import type { Conversation } from "../types.js";
import { cacheMapping, listCached, lookupId } from "./cache.js";
import {
	cacheConversation,
	fetchConversation,
	getCachedConversation,
	inferKindFromId,
} from "./conversation-cache.js";
import { parseSlackUrl } from "./url.js";
import { resolveUser } from "./user.js";

const CACHE_FILE = "channels.json";

/** Pattern matching Slack channel IDs (C, D, or G prefix). */
const CHANNEL_ID_PATTERN = /^[CDG][A-Z0-9]{8,}$/;

/** Pattern matching Slack user IDs (U or W prefix). */
const USER_ID_PATTERN = /^[UW][A-Z0-9]{8,}$/;

/**
 * Resolve a conversation identifier to a Conversation.
 *
 * Accepts:
 *   - Channel ID (C..., D..., G...) → fetched via cache or conversations.info
 *   - User ID (U..., W...) → opens/finds the DM conversation via conversations.open
 *   - @handle (e.g. "@joel.gerber") → resolved to user ID via search, then DM
 *   - Channel name (with or without #) → resolved via file cache, then search
 *   - Slack URL → parsed for the channel ID
 */
export async function resolveConversation(
	client: SlackClient,
	input: string,
): Promise<Conversation> {
	// Channel ID: look up metadata.
	if (CHANNEL_ID_PATTERN.test(input)) {
		return resolveById(client, input);
	}

	// User ID: open a DM conversation with that user.
	if (USER_ID_PATTERN.test(input)) {
		return openDmConversation(client, input);
	}

	// Slack URL: extract channel ID directly.
	const parsed = parseSlackUrl(input);
	if (parsed) return resolveById(client, parsed.channel);

	// URL that contains /archives/CHANNELID/ but didn't match the full pattern.
	const archiveMatch = input.match(/archives\/([CDG][A-Z0-9]+)/);
	if (archiveMatch) return resolveById(client, archiveMatch[1]);

	// User handle: @joel.gerber → resolve to user ID, then DM.
	if (input.startsWith("@")) {
		const userId = await resolveUser(client, input.slice(1));
		return openDmConversation(client, userId);
	}

	// Channel name: strip leading #.
	const name = input.startsWith("#") ? input.slice(1) : input;

	// Recheck after stripping: #U098TB6UXGA → U098TB6UXGA is a user ID.
	if (USER_ID_PATTERN.test(name)) {
		return openDmConversation(client, name);
	}

	// Check file cache for name → ID mapping.
	const cachedId = lookupId(CACHE_FILE, name);
	if (cachedId) return resolveById(client, cachedId);

	// Resolve via search. Enterprise grids block conversations.list,
	// but search.messages with in:#channel works across the grid.
	const response = await client.call<{
		messages: {
			matches: Array<{
				channel: { id: string; name: string };
			}>;
		};
	}>("search.messages", {
		query: `in:#${name} *`,
		count: 1,
	});

	const match = response.messages?.matches?.[0];
	if (match?.channel?.id) {
		cacheChannelName(match.channel.name, match.channel.id);
		const conversation: Conversation = {
			id: match.channel.id,
			name: match.channel.name,
			kind: "channel",
			displayName: `#${match.channel.name}`,
		};
		cacheConversation(conversation);
		return conversation;
	}

	throw new Error(
		`Could not resolve channel "${input}". ` +
			"Use a channel ID (e.g. C0ACMKCS6UW) or verify the channel name.",
	);
}

/**
 * Record a channel name → ID mapping.
 * Called opportunistically when channel data appears in API responses.
 */
export function cacheChannelName(name: string, id: string): void {
	if (name && id) {
		cacheMapping(CACHE_FILE, name, id);
	}
}

/** List all cached channel mappings. */
export function listCachedChannels(): Array<{ name: string; id: string }> {
	return listCached(CACHE_FILE);
}

/**
 * Resolve a channel ID to a Conversation.
 *
 * Uses the shared conversation cache for the fast path,
 * falling back to conversations.info on cache miss.
 */
async function resolveById(
	client: SlackClient,
	id: string,
): Promise<Conversation> {
	const cached = getCachedConversation(id);
	if (cached) return cached;

	// Try conversations.info for full metadata.
	try {
		return await fetchConversation(client, id);
	} catch {
		// If conversations.info fails (permissions, etc.), fall back to
		// best-effort inference from the ID prefix.
		const conversation: Conversation = {
			id,
			kind: inferKindFromId(id),
		};
		cacheConversation(conversation);
		return conversation;
	}
}

/**
 * Open or find the DM conversation for a user ID.
 *
 * Uses conversations.open which returns the existing DM
 * if one exists, or creates it if not.
 */
async function openDmConversation(
	client: SlackClient,
	userId: string,
): Promise<Conversation> {
	const response = await client.call<{
		channel: { id: string };
	}>("conversations.open", { users: userId });

	const channelId = response.channel?.id;
	if (!channelId) {
		throw new Error(
			`Could not open DM conversation for user "${userId}". ` +
				"Verify the user ID is correct.",
		);
	}

	const conversation: Conversation = {
		id: channelId,
		kind: "dm",
		dmUserId: userId,
	};
	cacheConversation(conversation);
	return conversation;
}

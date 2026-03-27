/**
 * Shared in-memory conversation metadata cache.
 *
 * Both the conversation resolver (input resolution) and the
 * message enrichment step (output formatting) use this cache
 * as a single source of truth. Avoids duplicate conversations.info
 * calls across the two code paths.
 *
 * Session-scoped: cleared when the process exits. The file-based
 * name → ID cache in resolvers/cache.ts handles cross-session
 * persistence for name lookups; this cache handles richer metadata
 * (kind, displayName) within a session.
 */

import type { SlackClient } from "../api/client.js";
import type { Conversation, ConversationKind } from "../types.js";
import { displayNameForId } from "./user.js";

/** In-memory cache of resolved conversation metadata. */
const cache = new Map<string, Conversation>();

/** Look up a cached conversation by ID. */
export function getCachedConversation(id: string): Conversation | undefined {
	return cache.get(id);
}

/** Store a conversation in the cache. */
export function cacheConversation(conversation: Conversation): void {
	cache.set(conversation.id, conversation);
}

/**
 * Fetch conversation metadata, using the cache when possible.
 *
 * Calls conversations.info on cache miss, caches the result,
 * and returns a fully populated Conversation. Callers should
 * prefer getCachedConversation for the fast path.
 */
export async function fetchConversation(
	client: SlackClient,
	id: string,
	signal?: AbortSignal,
): Promise<Conversation> {
	const cached = cache.get(id);
	if (cached) return cached;

	const response = await client.call<{
		channel: {
			id: string;
			name?: string;
			is_im?: boolean;
			is_mpim?: boolean;
			is_channel?: boolean;
			user?: string;
			purpose?: { value?: string };
		};
	}>("conversations.info", { channel: id }, signal);

	const ch = response.channel;
	const conversation = toConversation(ch);
	cache.set(id, conversation);
	return conversation;
}

/**
 * Refresh display names on DM conversations after user resolution.
 *
 * Call after resolveUsersInMessages so displayNameForId
 * returns handles instead of raw IDs.
 */
export function refreshCachedDmNames(): void {
	for (const conv of cache.values()) {
		if (conv.kind === "dm" && conv.dmUserId) {
			const handle = displayNameForId(conv.dmUserId);
			if (handle !== conv.dmUserId) {
				conv.displayName = `@${handle}`;
			}
		}
	}
}

/**
 * Convert a conversations.info response to a Conversation.
 *
 * Shared parsing logic for the boolean fields Slack uses
 * to indicate conversation type.
 */
function toConversation(ch: {
	id: string;
	name?: string;
	is_im?: boolean;
	is_mpim?: boolean;
	user?: string;
	purpose?: { value?: string };
}): Conversation {
	if (ch.is_im) {
		const userId = ch.user;
		const handle = userId ? displayNameForId(userId) : undefined;
		const displayName =
			handle && handle !== userId ? `@${handle}` : userId ? userId : undefined;
		return {
			id: ch.id,
			kind: "dm",
			displayName,
			dmUserId: userId,
		};
	}

	if (ch.is_mpim) {
		const displayName = formatGroupDmName(ch.name, ch.purpose?.value);
		return {
			id: ch.id,
			kind: "group_dm",
			displayName,
		};
	}

	// Regular channel (public or private).
	return {
		id: ch.id,
		name: ch.name,
		kind: "channel",
		displayName: ch.name ? `#${ch.name}` : undefined,
	};
}

/**
 * Format a group DM name from the mpdm- format or purpose.
 *
 * Slack names group DMs like `mpdm-user1--user2--user3-1`.
 * The purpose field contains "Group messaging with: @user1
 * @user2 @user3". We prefer the purpose when available.
 */
function formatGroupDmName(rawName?: string, purpose?: string): string {
	if (purpose?.startsWith("Group messaging with:")) {
		const names = purpose
			.replace("Group messaging with:", "")
			.trim()
			.split(/\s+/)
			.map((n) => (n.startsWith("@") ? n : `@${n}`));
		return names.join(", ");
	}

	if (rawName?.startsWith("mpdm-")) {
		const stripped = rawName.replace(/^mpdm-/, "").replace(/-\d+$/, "");
		const users = stripped.split("--").map((u) => `@${u}`);
		return users.join(", ");
	}

	return "group DM";
}

/**
 * Infer conversation kind from a channel ID prefix.
 *
 * Best-effort guess used when we only have an ID and haven't
 * called conversations.info yet. D-prefix → DM, G-prefix →
 * group_dm, everything else → channel.
 */
export function inferKindFromId(id: string): ConversationKind {
	if (id.startsWith("D")) return "dm";
	if (id.startsWith("G")) return "group_dm";
	return "channel";
}

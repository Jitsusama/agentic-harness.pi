/**
 * Batch channel resolution for messages.
 *
 * After fetching messages from any API, this module resolves
 * channel IDs to display names and determines the channel kind
 * (channel, DM, group DM). This means the renderers always
 * show #channel-name, "DM with @person", or "Group DM with
 * @a, @b, @c" instead of raw IDs like C0AJY0FLK8Q.
 *
 * Uses conversations.info which works on enterprise grid
 * even when conversations.list is blocked. Results are cached
 * so repeated lookups are fast.
 */

import { cacheChannel } from "../resolvers/channel.js";
import { displayNameForId } from "../resolvers/user.js";
import type { ChannelKind, SlackMessage } from "../types.js";
import type { SlackClient } from "./client.js";

/** Resolved channel metadata. */
interface ChannelMeta {
	name: string;
	kind: ChannelKind;
	/** For DMs: the other person's user ID. */
	dmUserId?: string;
}

/**
 * In-memory cache of resolved channel metadata.
 *
 * Avoids redundant conversations.info calls within a session.
 * The file-based name→ID cache handles cross-session persistence.
 */
const channelMetaCache = new Map<string, ChannelMeta>();

/**
 * Resolve channel metadata for all unique channels in a list
 * of messages. Populates channelName and channelKind on each
 * message.
 *
 * Calls conversations.info for unknown channels, caches the
 * results, and resolves DM partner names. Silently skips
 * channels that fail to resolve.
 */
export async function resolveChannelsInMessages(
	client: SlackClient,
	messages: SlackMessage[],
	signal?: AbortSignal,
): Promise<void> {
	const unknownIds = new Set<string>();

	for (const msg of messages) {
		if (msg.channel && !channelMetaCache.has(msg.channel)) {
			unknownIds.add(msg.channel);
		}
	}

	// Resolve unknown channels via conversations.info.
	if (unknownIds.size > 0) {
		const ids = [...unknownIds];
		const BATCH_SIZE = 5;

		for (let i = 0; i < ids.length; i += BATCH_SIZE) {
			if (signal?.aborted) return;

			const batch = ids.slice(i, i + BATCH_SIZE);
			await Promise.all(
				batch.map(async (id) => {
					try {
						const meta = await resolveChannelMeta(client, id, signal);
						if (meta) {
							channelMetaCache.set(id, meta);
						}
					} catch {
						// Channel not found or inaccessible. Skip.
					}
				}),
			);
		}
	}

	// Apply resolved metadata to messages.
	for (const msg of messages) {
		if (!msg.channel) continue;

		const meta = channelMetaCache.get(msg.channel);
		if (meta) {
			msg.channelName = meta.name;
			msg.channelKind = meta.kind;
		}
	}
}

/**
 * Pre-populate the channel meta cache from search results.
 *
 * Search results include channel name but not channel type.
 * This avoids conversations.info calls for channels we've
 * already seen names for, but those entries won't have
 * accurate kind until conversations.info runs.
 */
export function cacheChannelName(channelId: string, name: string): void {
	if (channelMetaCache.has(channelId)) return;

	// Infer kind from the mpdm- prefix as a hint.
	// This is a best-effort guess; conversations.info will
	// provide the definitive answer.
	const kind: ChannelKind = name.startsWith("mpdm-") ? "group_dm" : "channel";
	channelMetaCache.set(channelId, {
		name: formatChannelName(name, kind),
		kind,
	});
}

/** Resolve a single channel's metadata via conversations.info. */
async function resolveChannelMeta(
	client: SlackClient,
	channelId: string,
	signal?: AbortSignal,
): Promise<ChannelMeta | null> {
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
	}>("conversations.info", { channel: channelId }, signal);

	const ch = response.channel;
	if (!ch) return null;

	if (ch.is_im) {
		const kind: ChannelKind = "dm";
		const userId = ch.user;

		// Cache the DM partner for user resolution.
		if (userId) {
			const name = displayNameForId(userId);
			const displayName = name !== userId ? name : undefined;
			return {
				name: displayName ? `DM with @${displayName}` : `DM with ${userId}`,
				kind,
				dmUserId: userId,
			};
		}
		return { name: "DM", kind };
	}

	if (ch.is_mpim) {
		const kind: ChannelKind = "group_dm";
		const name = formatGroupDmName(ch.name, ch.purpose?.value);
		return { name, kind };
	}

	// Regular channel.
	const name = ch.name ?? channelId;
	cacheChannel(name, channelId);
	return { name: `#${name}`, kind: "channel" };
}

/**
 * Format a group DM name from the mpdm- format or purpose.
 *
 * Slack names group DMs like `mpdm-user1--user2--user3-1`.
 * The purpose field contains "Group messaging with: @user1
 * @user2 @user3". We prefer the purpose when available.
 */
function formatGroupDmName(rawName?: string, purpose?: string): string {
	// Try the purpose field first — it has readable names.
	if (purpose?.startsWith("Group messaging with:")) {
		const names = purpose
			.replace("Group messaging with:", "")
			.trim()
			.split(/\s+/)
			.map((n) => (n.startsWith("@") ? n : `@${n}`));
		return `Group DM (${names.join(", ")})`;
	}

	// Fall back to parsing mpdm- name.
	if (rawName?.startsWith("mpdm-")) {
		const stripped = rawName.replace(/^mpdm-/, "").replace(/-\d+$/, "");
		const users = stripped.split("--").map((u) => `@${u}`);
		return `Group DM (${users.join(", ")})`;
	}

	return "Group DM";
}

/**
 * Format a channel name for display based on kind.
 * Used for search result cache entries where we only have
 * the name, not full metadata.
 */
function formatChannelName(name: string, kind: ChannelKind): string {
	if (kind === "group_dm") {
		return formatGroupDmName(name);
	}
	return `#${name}`;
}

/**
 * Update DM channel names after user resolution.
 *
 * Call this after resolveUsersInMessages to refresh DM
 * channel names with resolved @handles instead of raw IDs.
 */
export function refreshDmNames(messages: SlackMessage[]): void {
	for (const msg of messages) {
		if (!msg.channel) continue;
		const meta = channelMetaCache.get(msg.channel);
		if (meta?.kind === "dm" && meta.dmUserId) {
			const name = displayNameForId(meta.dmUserId);
			if (name !== meta.dmUserId) {
				meta.name = `DM with @${name}`;
				msg.channelName = meta.name;
			}
		}
	}
}

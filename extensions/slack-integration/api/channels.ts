/**
 * Slack channel API: info and metadata.
 */

import { cacheChannel } from "../resolvers/channel.js";
import type { SlackChannel } from "../types.js";
import type { SlackClient } from "./client.js";

/**
 * Fetch detailed info about a channel.
 *
 * Uses conversations.info which works with client tokens
 * on enterprise grids.
 */
export async function getChannelInfo(
	client: SlackClient,
	channelId: string,
	signal?: AbortSignal,
): Promise<SlackChannel> {
	const response = await client.call<{
		channel: {
			id: string;
			name: string;
			topic?: { value?: string };
			purpose?: { value?: string };
			num_members?: number;
			is_archived?: boolean;
			is_private?: boolean;
			created?: number;
		};
	}>("conversations.info", { channel: channelId }, signal);

	const ch = response.channel;

	// Cache the name → ID mapping.
	if (ch?.name && ch?.id) {
		cacheChannel(ch.name, ch.id);
	}

	return {
		id: ch.id,
		name: ch.name,
		topic: ch.topic?.value || undefined,
		purpose: ch.purpose?.value || undefined,
		memberCount: ch.num_members,
		isArchived: ch.is_archived ?? false,
		isPrivate: ch.is_private ?? false,
		created: ch.created,
	};
}

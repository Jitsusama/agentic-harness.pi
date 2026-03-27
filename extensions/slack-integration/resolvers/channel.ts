/**
 * Channel name → ID resolver.
 *
 * Accepts channel names (with or without #), channel IDs, and
 * Slack URLs. Caches mappings at ~/.pi/agent/slack/channels.json
 * and resolves unknown names via search.messages.
 *
 * On enterprise grids, conversations.list is blocked, so we
 * resolve channel names by searching for a message in that
 * channel and extracting the channel ID from the result.
 */

import type { SlackClient } from "../api/client.js";
import { cacheMapping, listCached, lookupId } from "./cache.js";
import { parseSlackUrl } from "./url.js";

const CACHE_FILE = "channels.json";

/** Pattern matching Slack channel IDs (C, D, or G prefix). */
const CHANNEL_ID_PATTERN = /^[CDG][A-Z0-9]{8,}$/;

/**
 * Resolve a channel identifier to a channel ID.
 *
 * Accepts:
 *   - Channel ID (C..., D..., G...) → returned as-is
 *   - Channel name (with or without #) → resolved via cache, then search
 *   - Slack URL → parsed for the channel ID
 */
export async function resolveChannel(
	client: SlackClient,
	input: string,
): Promise<string> {
	if (CHANNEL_ID_PATTERN.test(input)) {
		return input;
	}

	// Slack URL: extract channel ID directly.
	const parsed = parseSlackUrl(input);
	if (parsed) return parsed.channel;

	// URL that contains /archives/CHANNELID/ but didn't match the full pattern.
	const archiveMatch = input.match(/archives\/([CDG][A-Z0-9]+)/);
	if (archiveMatch) return archiveMatch[1];

	// Channel name: strip leading #.
	const name = input.startsWith("#") ? input.slice(1) : input;

	// Check cache first.
	const cached = lookupId(CACHE_FILE, name);
	if (cached) return cached;

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
		cacheChannel(match.channel.name, match.channel.id);
		return match.channel.id;
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
export function cacheChannel(name: string, id: string): void {
	if (name && id) {
		cacheMapping(CACHE_FILE, name, id);
	}
}

/** List all cached channel mappings. */
export function listCachedChannels(): Array<{ name: string; id: string }> {
	return listCached(CACHE_FILE);
}

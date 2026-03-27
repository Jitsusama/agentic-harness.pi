/**
 * Resolve a message target to a channel ID and timestamp.
 *
 * Many actions accept either a Slack permalink URL or a
 * channel + timestamp pair. This module centralises that
 * resolution so handlers don't repeat it.
 */

import type { SlackClient } from "../api/client.js";
import { resolveChannel } from "./channel.js";
import { parseSlackUrl } from "./url.js";

/** Resolved message target: a channel ID and timestamp. */
export interface MessageTarget {
	channel: string;
	ts: string;
}

/**
 * Resolve a message target from tool parameters.
 *
 * Accepts:
 *   - target (Slack URL) → parsed directly
 *   - channel + ts → channel resolved via resolver
 *
 * Throws if neither provides enough information.
 */
export async function resolveTarget(
	client: SlackClient,
	target: string | undefined,
	channel: string | undefined,
	ts: string | undefined,
): Promise<MessageTarget> {
	// Slack permalink URL takes priority.
	if (target) {
		const parsed = parseSlackUrl(target);
		if (parsed) return parsed;

		// If it looks like a URL but didn't parse, try as a channel name.
		if (!target.startsWith("http")) {
			const resolvedChannel = await resolveChannel(client, target);
			if (ts) return { channel: resolvedChannel, ts };
		}

		throw new Error(
			"Could not parse the target URL. Provide a valid Slack permalink, " +
				"or use the channel and ts parameters instead.",
		);
	}

	// Channel + timestamp pair.
	if (channel && ts) {
		const resolvedChannel = await resolveChannel(client, channel);
		return { channel: resolvedChannel, ts };
	}

	if (channel && !ts) {
		throw new Error(
			"Missing timestamp (ts). Provide a message timestamp or use a Slack permalink URL as the target.",
		);
	}

	throw new Error(
		"Missing target. Provide a Slack permalink URL (target) or a channel + timestamp (ts) pair.",
	);
}

/**
 * Resolve a message target to a Conversation and timestamp.
 *
 * Many actions accept either a Slack permalink URL or a
 * channel + timestamp pair. This module centralises that
 * resolution so handlers don't repeat it.
 */

import type { SlackClient } from "../api/client.js";
import type { MessageTarget } from "../types.js";
import { resolveConversation } from "./conversation.js";
import { parseSlackUrl } from "./url.js";

/**
 * Resolve a message target from tool parameters.
 *
 * Accepts:
 *   - target (Slack URL) → parsed, then conversation resolved
 *   - channel + ts → conversation resolved
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
		if (parsed) {
			const conversation = await resolveConversation(client, parsed.channel);
			return { conversation, ts: parsed.ts };
		}

		// If it looks like a URL but didn't parse, try as a channel name.
		if (!target.startsWith("http")) {
			const conversation = await resolveConversation(client, target);
			if (ts) return { conversation, ts };
		}

		throw new Error(
			"Could not parse the target URL. Provide a valid Slack permalink, " +
				"or use the channel and ts parameters instead.",
		);
	}

	// Channel + timestamp pair.
	if (channel && ts) {
		const conversation = await resolveConversation(client, channel);
		return { conversation, ts };
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

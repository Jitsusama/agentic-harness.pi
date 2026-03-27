/**
 * Batch user ID resolution for messages.
 *
 * After fetching messages from any API (search, history,
 * replies), this module resolves all user IDs to display
 * names and updates the user cache. This means the renderers
 * and collapsed previews always show @handles instead of
 * raw IDs like U08ME9KASG7.
 */

import { lookupName } from "../resolvers/cache.js";
import { cacheUser } from "../resolvers/user.js";
import type { SlackMessage } from "../types.js";
import type { SlackClient } from "./client.js";

/** Cache filename used by the user resolver. */
const USER_CACHE_FILE = "users.json";

/**
 * Resolve all unknown user IDs in a list of messages.
 *
 * Collects unique user IDs that aren't in the local cache,
 * calls users.info for each, and caches the results. After
 * this call, displayNameForId() will return handles for all
 * users in the messages.
 *
 * Silently skips users that fail to resolve (deleted accounts,
 * bots without profiles).
 */
export async function resolveUsersInMessages(
	client: SlackClient,
	messages: SlackMessage[],
	signal?: AbortSignal,
): Promise<void> {
	const unknownIds = new Set<string>();

	for (const msg of messages) {
		if (msg.user && !lookupName(USER_CACHE_FILE, msg.user)) {
			unknownIds.add(msg.user);
		}
	}

	if (unknownIds.size === 0) return;

	// Resolve in parallel with a concurrency limit to avoid
	// hitting rate limits on large result sets.
	const ids = [...unknownIds];
	const BATCH_SIZE = 5;

	for (let i = 0; i < ids.length; i += BATCH_SIZE) {
		if (signal?.aborted) return;

		const batch = ids.slice(i, i + BATCH_SIZE);
		await Promise.all(
			batch.map(async (id) => {
				try {
					const response = await client.call<{
						user: {
							id: string;
							name: string;
							profile?: {
								display_name?: string;
							};
						};
					}>("users.info", { user: id }, signal);

					const u = response.user;
					if (u?.name && u?.id) {
						cacheUser(u.name, u.id);
					}
				} catch {
					// User not found, deleted, or rate limited.
					// Silently skip — displayNameForId falls back to raw ID.
				}
			}),
		);
	}
}

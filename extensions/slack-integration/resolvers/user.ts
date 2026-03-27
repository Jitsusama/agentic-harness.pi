/**
 * User handle → ID resolver.
 *
 * Accepts user handles (with or without @) and user IDs. Caches
 * mappings at ~/.pi/agent/slack/users.json and resolves unknown
 * handles via search.messages.
 *
 * On enterprise grids, users.list and users.lookupByEmail are
 * blocked, so we resolve handles by searching for a message
 * from that user and extracting the user ID from the result.
 */

import type { SlackClient } from "../api/client.js";
import { cacheMapping, listCached, lookupId, lookupName } from "./cache.js";

const CACHE_FILE = "users.json";

/** Pattern matching Slack user IDs (U or W prefix). */
const USER_ID_PATTERN = /^[UW][A-Z0-9]{8,}$/;

/**
 * Resolve a user identifier to a user ID.
 *
 * Accepts:
 *   - User ID (U... or W...) → returned as-is
 *   - Username/handle (with or without @) → resolved via cache, then search
 */
export async function resolveUser(
	client: SlackClient,
	input: string,
): Promise<string> {
	if (USER_ID_PATTERN.test(input)) {
		return input;
	}

	// Strip leading @.
	const name = input.startsWith("@") ? input.slice(1) : input;

	// Check cache first.
	const cached = lookupId(CACHE_FILE, name);
	if (cached) return cached;

	// Resolve via search. Enterprise grids block users.list,
	// but search.messages with from:username works.
	const response = await client.call<{
		messages: {
			matches: Array<{
				user: string;
				username: string;
			}>;
		};
	}>("search.messages", {
		query: `from:${name} *`,
		count: 1,
	});

	const match = response.messages?.matches?.[0];
	if (match?.user && match?.username) {
		cacheUser(match.username, match.user);
		return match.user;
	}

	throw new Error(
		`Could not resolve user "${input}". ` +
			"Use a user ID (e.g. U0123ABC) or verify the username.",
	);
}

/**
 * Look up a display name for a user ID from the local cache.
 * Returns the cached handle if found, or the raw ID if not.
 * Local-only: no API calls.
 */
export function displayNameForId(userId: string): string {
	return lookupName(CACHE_FILE, userId) ?? userId;
}

/**
 * Resolve a batch of user IDs to display names using the local cache.
 * Returns a map of userId → displayName (handle if cached, raw ID if not).
 * Local-only: no API calls.
 */
export function resolveUserIdsFromCache(
	userIds: string[],
): Map<string, string> {
	const result = new Map<string, string>();
	for (const id of userIds) {
		result.set(id, lookupName(CACHE_FILE, id) ?? id);
	}
	return result;
}

/**
 * Record a user handle → ID mapping.
 * Called opportunistically when user data appears in API responses.
 */
export function cacheUser(name: string, id: string): void {
	if (name && id) {
		cacheMapping(CACHE_FILE, name, id);
	}
}

/** List all cached user mappings. */
export function listCachedUsers(): Array<{ name: string; id: string }> {
	return listCached(CACHE_FILE);
}

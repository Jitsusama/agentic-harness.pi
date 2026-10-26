/**
 * User handle → ID resolver.
 *
 * Accepts user handles (with or without @) and user IDs. Caches
 * mappings at ~/.pi/agent/slack/users.json and resolves unknown
 * handles via search.messages.
 *
 * On enterprise grids, users.list and users.lookupByEmail are
 * often blocked, so we resolve handles by searching for a message
 * from that user and extracting the user ID from the result.
 *
 * Often, not always: the email lookup is worth trying, because it
 * is the only form that resolves somebody who has never posted a
 * message the searcher can see. A blocked grid answers with an
 * error, which degrades to the search rather than reaching the
 * caller. A full name is refused outright, since `from:Chao Duan`
 * cannot match and spending a call to learn that helps nobody.
 */

import type { SlackClient } from "../api/client.ts";
import { cacheMapping, listCached, lookupId, lookupName } from "./cache.ts";

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
	signal?: AbortSignal,
): Promise<string> {
	if (USER_ID_PATTERN.test(input)) {
		return input;
	}

	// Strip leading @.
	const name = input.startsWith("@") ? input.slice(1) : input;

	// Check cache first.
	const cached = lookupId(CACHE_FILE, name);
	if (cached) return cached;

	// A display name cannot be searched for: `from:` takes a handle, so
	// `from:Chao Duan *` matches nothing and the failure arrives after a
	// round trip, phrased as though the name were misspelled.
	if (/\s/.test(name)) {
		throw new Error(
			`Could not resolve user "${input}": a full name cannot be looked up. ` +
				"Use their email address, their Slack handle (as in @joel.gerber) " +
				"or a user ID (as in U0123ABC).",
		);
	}

	// An email is the one form that resolves somebody who has posted
	// nothing visible. Blocked on some grids, which is not the caller's
	// problem: the handle before the @ is searched for instead, since
	// `from:` takes a handle and never matches an address. On Shopify's
	// grid the lookup has never once answered: 1,031 cached people and
	// not one by email, so every email had failed.
	if (name.includes("@")) {
		const byEmail = await lookUpByEmail(client, name, signal);
		if (byEmail) return byEmail;
		const handle = name.slice(0, name.indexOf("@"));
		const id = handle
			? (lookupId(CACHE_FILE, handle) ??
				(await searchByHandle(client, handle, signal)))
			: undefined;
		if (id) {
			cacheUser(name, id);
			return id;
		}
		throw new Error(
			`Could not resolve user "${input}": this workspace would not look the ` +
				`address up, and nobody posting as @${handle} was found. Their handle ` +
				"may differ or they may have left; a user ID (as in U0123ABC) always works.",
		);
	}

	const id = await searchByHandle(client, name, signal);
	if (id) return id;

	throw new Error(
		`Could not resolve user "${input}": nobody posting as @${name} was found. ` +
			"Use their email address or a user ID (as in U0123ABC), or check the handle.",
	);
}

/**
 * The user who posts as `handle`, from a search for one of their messages,
 * or undefined when the searcher can see none. Enterprise grids block
 * users.list, but search.messages with `from:handle` works.
 */
async function searchByHandle(
	client: SlackClient,
	handle: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	const response = await client.call<{
		messages: {
			matches: Array<{
				user: string;
				username: string;
			}>;
		};
	}>("search.messages", { query: `from:${handle} *`, count: 1 }, signal);

	const match = response.messages?.matches?.[0];
	if (!match?.user || !match?.username) return undefined;
	cacheUser(match.username, match.user);
	return match.user;
}

/**
 * The user behind an email address, or undefined when this grid will not
 * say.
 *
 * A refusal here is expected rather than exceptional: the method is
 * commonly restricted, and a caller who passed an email should get the
 * search's answer instead of the grid's policy.
 */
async function lookUpByEmail(
	client: SlackClient,
	email: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	try {
		const response = await client.call<{
			user?: { id?: string; name?: string };
		}>("users.lookupByEmail", { email }, signal);
		const id = response.user?.id;
		if (!id) return undefined;
		if (response.user?.name) cacheUser(response.user.name, id);
		cacheUser(email, id);
		return id;
	} catch {
		// Blocked, or no such address. Either way the search may still
		// answer, and the refusal at the end of the caller says both forms.
		return undefined;
	}
}

/** Cache file for channel name ↔ ID mappings. */
const CHANNEL_CACHE_FILE = "channels.json";

/**
 * Look up a display name for any Slack entity ID.
 *
 * Routes by ID prefix:
 *   - U/W → user cache (users.json)
 *   - C/G → channel cache (channels.json)
 *
 * Returns the cached name if found, the raw ID otherwise.
 * Local-only: no API calls.
 */
export function displayNameForId(id: string): string {
	if (id.startsWith("C") || id.startsWith("G")) {
		return lookupName(CHANNEL_CACHE_FILE, id) ?? id;
	}
	return lookupName(CACHE_FILE, id) ?? id;
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

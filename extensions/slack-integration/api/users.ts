/**
 * Slack user API: profiles and info.
 */

import { cacheUser } from "../resolvers/user.js";
import type { SlackUser } from "../types.js";
import type { SlackClient } from "./client.js";

/**
 * Fetch a user's profile by ID.
 *
 * Uses users.info which works with client tokens on
 * enterprise grids (unlike users.list).
 */
export async function getUserInfo(
	client: SlackClient,
	userId: string,
	signal?: AbortSignal,
): Promise<SlackUser> {
	const response = await client.call<{
		user: {
			id: string;
			name: string;
			real_name?: string;
			profile?: {
				display_name?: string;
				real_name?: string;
				title?: string;
				email?: string;
				status_text?: string;
				status_emoji?: string;
			};
			is_bot?: boolean;
			is_admin?: boolean;
			tz?: string;
			deleted?: boolean;
		};
	}>("users.info", { user: userId }, signal);

	const u = response.user;
	const profile = u.profile ?? {};

	// Cache the handle → ID mapping.
	if (u.name && u.id) {
		cacheUser(u.name, u.id);
	}

	return {
		id: u.id,
		name: u.name,
		realName: profile.real_name ?? u.real_name,
		displayName: profile.display_name || undefined,
		title: profile.title || undefined,
		email: profile.email || undefined,
		isBot: u.is_bot ?? false,
		isAdmin: u.is_admin ?? false,
		timezone: u.tz,
		statusText: profile.status_text || undefined,
		statusEmoji: profile.status_emoji || undefined,
		deleted: u.deleted ?? false,
	};
}

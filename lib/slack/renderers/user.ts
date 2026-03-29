/**
 * Format user profiles as readable text.
 */

import type { SlackUser } from "../types.js";

/** Render a user profile as a readable summary. */
export function renderUser(user: SlackUser): string {
	const lines: string[] = [];

	const displayName = user.displayName || user.realName || user.name;
	lines.push(`**@${user.name}** (${displayName})`);

	if (user.title) lines.push(`Title: ${user.title}`);
	if (user.email) lines.push(`Email: ${user.email}`);
	if (user.timezone) lines.push(`Timezone: ${user.timezone}`);

	if (user.statusText || user.statusEmoji) {
		const status = [user.statusEmoji, user.statusText]
			.filter(Boolean)
			.join(" ");
		lines.push(`Status: ${status}`);
	}

	const flags: string[] = [];
	if (user.isBot) flags.push("bot");
	if (user.isAdmin) flags.push("admin");
	if (user.deleted) flags.push("deactivated");
	if (flags.length > 0) lines.push(`Flags: ${flags.join(", ")}`);

	lines.push(`ID: ${user.id}`);

	return lines.join("\n");
}

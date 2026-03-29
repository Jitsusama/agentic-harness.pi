/**
 * Format channel info as readable text.
 */

import type { SlackChannel } from "../types.js";

/** Render channel info as a readable summary. */
export function renderChannel(ch: SlackChannel): string {
	const lines: string[] = [];

	const flags: string[] = [];
	if (ch.isPrivate) flags.push("private");
	if (ch.isArchived) flags.push("archived");
	const suffix = flags.length > 0 ? ` (${flags.join(", ")})` : "";

	lines.push(`**#${ch.name}**${suffix}`);

	if (ch.topic) lines.push(`Topic: ${ch.topic}`);
	if (ch.purpose) lines.push(`Purpose: ${ch.purpose}`);
	if (ch.memberCount !== undefined) {
		lines.push(`Members: ${ch.memberCount}`);
	}
	if (ch.created) {
		const date = new Date(ch.created * 1000);
		lines.push(`Created: ${date.toLocaleDateString()}`);
	}

	lines.push(`ID: ${ch.id}`);

	return lines.join("\n");
}

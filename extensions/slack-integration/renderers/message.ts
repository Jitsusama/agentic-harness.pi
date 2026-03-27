/**
 * Format Slack messages and threads as readable text.
 *
 * Converts Slack's mrkdwn format to markdown-like output.
 * User IDs (<@U123>) are resolved from the local cache
 * when possible.
 */

import { displayNameForId } from "../resolvers/user.js";
import type { SlackMessage } from "../types.js";

/**
 * Convert Slack mrkdwn to readable text.
 *
 * Handles user mentions, channel links, URL links, and
 * basic formatting differences between Slack and markdown.
 */
export function formatSlackText(text: string): string {
	return (
		text
			// User mentions with label: <@U123|display.name> → @display.name
			.replace(
				/<@([UW][A-Z0-9]+)\|([^>]+)>/g,
				(_match, _id: string, name: string) => `@${name}`,
			)
			// User mentions without label: <@U123> → @username or @U123
			.replace(/<@([UW][A-Z0-9]+)>/g, (_match, id: string) => {
				return `@${displayNameForId(id)}`;
			})
			// Channel links: <#C123|channel-name> → #channel-name
			.replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1")
			// Channel links without label: <#C123> → #C123
			.replace(/<#([A-Z0-9]+)>/g, "#$1")
			// URL links with label: <url|text> → [text](url)
			.replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "[$2]($1)")
			// URL links without label: <url> → url
			.replace(/<(https?:\/\/[^>]+)>/g, "$1")
			// Mailto links: <mailto:a@b.com|a@b.com> → a@b.com
			.replace(/<mailto:([^|>]+)\|([^>]+)>/g, "$2")
			.replace(/<mailto:([^>]+)>/g, "$1")
			// Slack bold *text* → **text** (markdown bold)
			.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "**$1**")
	);
}

/** Format a single message as a readable block. */
export function renderMessage(msg: SlackMessage): string {
	const parts: string[] = [];

	const user = msg.user ? `@${displayNameForId(msg.user)}` : "unknown";
	const ts = formatTimestamp(msg.ts);
	const where = msg.channelName ? ` (${msg.channelName})` : "";
	parts.push(`**${user}** ${ts}${where}`);

	if (msg.text) {
		parts.push(formatSlackText(msg.text));
	}

	if (msg.reactions?.length) {
		const rxns = msg.reactions.map((r) => `:${r.name}: ${r.count}`).join("  ");
		parts.push(rxns);
	}

	if (msg.permalink) {
		parts.push(`[link](${msg.permalink})`);
	}

	return parts.join("\n");
}

/** Format a list of messages (search results or channel history). */
export function renderMessageList(
	messages: SlackMessage[],
	total?: number,
): string {
	if (messages.length === 0) {
		return "No messages found.";
	}

	const lines: string[] = [];

	if (total !== undefined) {
		lines.push(`Found ${total} message(s), showing ${messages.length}:\n`);
	}

	for (const msg of messages) {
		lines.push(renderMessage(msg));
		lines.push(""); // Blank line separator
	}

	return lines.join("\n").trimEnd();
}

/** Format a thread as a readable conversation. */
export function renderThread(messages: SlackMessage[]): string {
	if (messages.length === 0) {
		return "Empty thread.";
	}

	const lines: string[] = [];
	lines.push(`Thread with ${messages.length} message(s):\n`);

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		const prefix = i === 0 ? "┌" : i === messages.length - 1 ? "└" : "├";
		const user = msg.user ? `@${displayNameForId(msg.user)}` : "unknown";
		const ts = formatTimestamp(msg.ts);

		lines.push(`${prefix} **${user}** ${ts}`);
		if (msg.text) {
			const indent = i === messages.length - 1 ? "  " : "│ ";
			for (const line of formatSlackText(msg.text).split("\n")) {
				lines.push(`${indent}${line}`);
			}
		}
		if (i < messages.length - 1) lines.push("│");
	}

	return lines.join("\n");
}

/** Format a Slack timestamp as a human-readable date/time. */
function formatTimestamp(ts: string): string {
	try {
		const epochSeconds = Number.parseFloat(ts);
		const date = new Date(epochSeconds * 1000);
		return date.toLocaleString(undefined, {
			month: "short",
			day: "numeric",
			hour: "numeric",
			minute: "2-digit",
		});
	} catch {
		return ts;
	}
}

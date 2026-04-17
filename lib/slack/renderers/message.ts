/**
 * Format Slack messages and threads as readable text.
 *
 * Converts Slack's mrkdwn format to markdown-like output.
 * User IDs (<@U123>) are resolved from the local cache
 * when possible.
 */

import { cacheChannelName } from "../resolvers/conversation.js";
import { cacheUser, displayNameForId } from "../resolvers/user.js";
import type { SlackMessage, SlackTable } from "../types.js";

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
			// Opportunistically cache the name → ID mapping for later unlabelled mentions.
			.replace(
				/<@([UW][A-Z0-9]+)\|([^>]+)>/g,
				(_match, id: string, name: string) => {
					cacheUser(name, id);
					return `@${name}`;
				},
			)
			// User mentions without label: <@U123> → @username or @U123
			.replace(/<@([UW][A-Z0-9]+)>/g, (_match, id: string) => {
				return `@${displayNameForId(id)}`;
			})
			// Broadcast mentions: <!here>, <!channel>, <!everyone> → @here etc.
			.replace(/<!(here|channel|everyone)>/g, "@$1")
			// Channel links with label: <#C123|channel-name> → #channel-name
			// Opportunistically cache the name → ID mapping.
			.replace(
				/<#([A-Z0-9]+)\|([^>]+)>/g,
				(_match, id: string, name: string) => {
					cacheChannelName(name, id);
					return `#${name}`;
				},
			)
			// Channel links without label: <#C123> → #channel-name (via cache)
			.replace(/<#([A-Z0-9]+)>/g, (_match, id: string) => {
				return `#${displayNameForId(id)}`;
			})
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

/**
 * Render a SlackTable as a pipe-delimited markdown table.
 *
 * Pads cells to column widths for readability.
 */
function renderTable(table: SlackTable): string {
	// Calculate column widths.
	const widths = table.columns.map((col, i) =>
		Math.max(col.length, ...table.rows.map((row) => (row[i] ?? "").length)),
	);

	// Header row.
	const header = table.columns
		.map((col, i) => col.padEnd(widths[i]))
		.join(" | ");

	// Separator row.
	const separator = widths.map((w) => "-".repeat(w)).join(" | ");

	// Data rows.
	const rows = table.rows.map((row) =>
		row.map((cell, i) => (cell ?? "").padEnd(widths[i])).join(" | "),
	);

	return [
		`| ${header} |`,
		`| ${separator} |`,
		...rows.map((r) => `| ${r} |`),
	].join("\n");
}

/** Format a single message as a readable block. */
export function renderMessage(msg: SlackMessage): string {
	const parts: string[] = [];

	const user = msg.user ? `@${displayNameForId(msg.user)}` : "unknown";
	const ts = formatTimestamp(msg.ts);
	const where = msg.conversation?.displayName
		? ` (${msg.conversation.displayName})`
		: "";
	const replyTag = msg.replyCount
		? ` [${msg.replyCount} ${msg.replyCount === 1 ? "reply" : "replies"}]`
		: "";
	parts.push(`**${user}** ${ts} (ts:${msg.ts})${where}${replyTag}`);

	if (msg.text) {
		parts.push(formatSlackText(msg.text));
	}

	if (msg.tables?.length) {
		for (const table of msg.tables) {
			parts.push(renderTable(table));
		}
	}

	if (msg.attachments?.length) {
		for (const att of msg.attachments) {
			const title = att.title || att.fallback;
			const url = att.fromUrl || att.imageUrl;
			if (title && url) {
				parts.push(`📎 [${title}](${url})`);
			} else if (title) {
				parts.push(`📎 ${title}`);
			} else if (url) {
				parts.push(`📎 ${url}`);
			}
			if (att.text) {
				parts.push(formatSlackText(att.text));
			}
		}
	}

	if (msg.files?.length) {
		for (const f of msg.files) {
			const type = f.mimetype ? ` [${f.mimetype}]` : "";
			parts.push(`📄 ${f.name}${type}`);
		}
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
	query?: string,
): string {
	if (messages.length === 0) {
		return "No messages found.";
	}

	const lines: string[] = [];

	if (query) {
		lines.push(`Query: ${query}`);
	}
	if (total !== undefined) {
		const truncated = total > messages.length;
		const showing = truncated
			? `, showing ${messages.length} (limit reached — pass a higher limit or 0 for all)`
			: `, showing ${messages.length}`;
		lines.push(`Found ${total} message(s)${showing}:\n`);
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

		lines.push(`${prefix} **${user}** ${ts} (ts:${msg.ts})`);
		const indent = i === messages.length - 1 ? "  " : "│ ";
		if (msg.text) {
			for (const line of formatSlackText(msg.text).split("\n")) {
				lines.push(`${indent}${line}`);
			}
		}
		if (msg.tables?.length) {
			for (const table of msg.tables) {
				for (const line of renderTable(table).split("\n")) {
					lines.push(`${indent}${line}`);
				}
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

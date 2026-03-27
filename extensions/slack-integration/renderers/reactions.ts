/**
 * Format reaction data as readable text.
 */

import type { MessageReactions, ReactedMessage } from "../api/reactions.js";
import { displayNameForId } from "../resolvers/user.js";
import { formatSlackText } from "./message.js";

/** Render reactions on a specific message. */
export function renderMessageReactions(data: MessageReactions): string {
	const lines: string[] = [];

	if (data.text) {
		const user = data.user ? `@${displayNameForId(data.user)}` : "unknown";
		lines.push(`**${user}**: ${formatSlackText(data.text)}`);
		lines.push("");
	}

	if (data.reactions.length === 0) {
		lines.push("No reactions.");
	} else {
		lines.push("Reactions:");
		for (const r of data.reactions) {
			lines.push(`  :${r.name}: × ${r.count}`);
		}
	}

	return lines.join("\n");
}

/** Render a list of messages the user reacted to. */
export function renderReactedMessages(messages: ReactedMessage[]): string {
	if (messages.length === 0) {
		return "No reactions found.";
	}

	const lines: string[] = [];
	lines.push(`${messages.length} message(s) with reactions:\n`);

	for (const msg of messages) {
		const user = msg.user ? `@${displayNameForId(msg.user)}` : "unknown";
		const text = msg.text
			? formatSlackText(msg.text).slice(0, 80)
			: "(no text)";
		const rxns = msg.reactions.map((r) => `:${r.name}: ${r.count}`).join("  ");

		lines.push(`- **${user}**: ${text}`);
		lines.push(`  ${rxns}`);
	}

	return lines.join("\n");
}

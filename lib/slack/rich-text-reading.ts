/**
 * Reading rich text Slack sent back as text, in the marks the message
 * renderer uses: bold as `**`, links as markdown, mentions by the name
 * the resolver cache knows. It changes when those marks do, or when
 * Slack sends an element of a new kind.
 */

import type { RichTextElement } from "./mrkdwn-tokens.ts";
import { displayNameForId } from "./resolvers/user.ts";

/**
 * Render a single rich text inline element to readable text.
 *
 * Follows the same output conventions as `formatSlackText`
 * in renderers/message.ts: bold → `**text**`, links →
 * `[text](url)`, user mentions → `@handle`, etc.
 */
function renderElement(el: RichTextElement): string {
	switch (el.type) {
		case "text": {
			let result = el.text ?? "";
			if (el.style?.code) result = `\`${result}\``;
			if (el.style?.strike) result = `~${result}~`;
			if (el.style?.italic) result = `_${result}_`;
			if (el.style?.bold) result = `**${result}**`;
			return result;
		}

		case "link": {
			const display = el.text || el.url || "";
			const url = el.url || "";
			return display && display !== url ? `[${display}](${url})` : url;
		}

		case "user": {
			const id = el.user_id ?? "";
			const name = displayNameForId(id);
			return `@${name}`;
		}

		case "channel": {
			const id = el.channel_id ?? "";
			const name = displayNameForId(id);
			return `#${name}`;
		}

		case "broadcast":
			return `@${el.range ?? "here"}`;

		case "emoji":
			return `:${el.name ?? ""}:`;

		default:
			return "";
	}
}

/**
 * Render a `rich_text` table cell to readable text.
 *
 * Walks the cell's elements → rich_text_section → inline
 * elements, converting each to text.
 */
export function renderRichTextCell(cell: unknown): string {
	const typed = cell as {
		type?: string;
		elements?: Array<{
			type?: string;
			elements?: RichTextElement[];
		}>;
	};

	if (typed.type !== "rich_text" || !Array.isArray(typed.elements)) {
		return "";
	}

	const parts: string[] = [];
	for (const section of typed.elements) {
		if (!Array.isArray(section.elements)) continue;
		for (const el of section.elements) {
			parts.push(renderElement(el));
		}
	}
	return parts.join("");
}

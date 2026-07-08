/**
 * Adapt pi session entries into the plain turn list the
 * governance distiller consumes.
 *
 * Only message entries carry conversation; their content is
 * either a plain string or a list of content blocks. Text is all
 * the distiller needs, so tool calls, images and non-message
 * entries are dropped and each message reduces to its role and
 * concatenated text.
 */

import type { Turn } from "../../lib/governance/index.js";

/** A content block that may carry text. */
interface TextBlock {
	type: string;
	text?: string;
}

/** A message entry as the session manager returns it. */
interface MessageLike {
	type: string;
	message?: {
		role?: string;
		content?: string | TextBlock[];
	};
}

/** Concatenate the text out of a message's content. */
function textOf(content: string | TextBlock[] | undefined): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b) => b.type === "text" && typeof b.text === "string")
		.map((b) => b.text)
		.join("");
}

/**
 * Reduce session entries to user and assistant text turns,
 * dropping everything that is not a message with text.
 */
export function entriesToTurns(entries: unknown[]): Turn[] {
	const turns: Turn[] = [];
	for (const entry of entries as MessageLike[]) {
		if (entry.type !== "message" || !entry.message) continue;
		const role = entry.message.role;
		if (role !== "user" && role !== "assistant") continue;
		const text = textOf(entry.message.content);
		if (text.trim().length === 0) continue;
		turns.push({ role, text });
	}
	return turns;
}

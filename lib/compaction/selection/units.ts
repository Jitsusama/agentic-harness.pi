/**
 * The paragraphs of a session the selection can tag and quote: what the
 * user typed and what the assistant said, one paragraph at a time.
 *
 * Tool results, thinking and tool calls are left out, since what they
 * hold is either repeated in the assistant's words or too long to
 * quote, and so are the messages the harness types to resume a run. A
 * paragraph too short to mean anything alone, or too long to quote, is
 * left out too.
 */

import { createHash } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { isResumeText } from "../resume.ts";
import { paragraphsOf } from "./paragraphs.ts";

/** Shorter than this and a paragraph says too little alone. */
const MIN_UNIT_CHARS = 12;

/** Longer than this and a paragraph would crowd out every other excerpt. */
export const MAX_UNIT_CHARS = 2000;

const HASH_CHARS = 16;

/** One paragraph of the session. */
export interface SelectionUnit {
	/** The entry the paragraph is in. */
	readonly entryId: string;
	/** Its position among the entry's paragraphs that were kept. */
	readonly index: number;
	/** Its text, whitespace aside, which is how a repeat is recognised. */
	readonly hash: string;
	readonly text: string;
	readonly speaker: "user" | "assistant";
}

/** The paragraphs of one entry, or none when it is not a message worth reading. */
export function unitsOf(entry: SessionEntry): SelectionUnit[] {
	const said = spokenText(entry);
	if (!said) return [];
	return paragraphsOf(said.text)
		.filter(
			(text) => text.length >= MIN_UNIT_CHARS && text.length <= MAX_UNIT_CHARS,
		)
		.map((text, index) => ({
			entryId: entry.id,
			index,
			hash: hashOf(text),
			text,
			speaker: said.speaker,
		}));
}

/** The paragraphs of every entry, in order. */
export function unitsOfBranch(
	entries: readonly SessionEntry[],
): SelectionUnit[] {
	return entries.flatMap(unitsOf);
}

/** A rough token count for a text, at four characters a token. */
export function estimatedTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function hashOf(text: string): string {
	return createHash("sha256")
		.update(text.replace(/\s+/g, " ").trim())
		.digest("hex")
		.slice(0, HASH_CHARS);
}

function spokenText(
	entry: SessionEntry,
): { text: string; speaker: "user" | "assistant" } | undefined {
	if (entry.type !== "message") return undefined;
	const { message } = entry;
	if (message.role === "user") {
		const text =
			typeof message.content === "string"
				? message.content
				: message.content
						.map((part) => (part.type === "text" ? part.text : ""))
						.join("\n\n");
		if (isResumeText(text)) return undefined;
		return { text, speaker: "user" };
	}
	if (message.role === "assistant") {
		const text = message.content
			.map((part) => (part.type === "text" ? part.text : ""))
			.filter(Boolean)
			.join("\n\n");
		return { text, speaker: "assistant" };
	}
	return undefined;
}

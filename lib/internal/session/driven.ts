/**
 * Whether a person drives a session: whether its log holds words a
 * person wrote, rather than only what the harness, peers and spawns
 * said.
 *
 * Every turn the harness starts opens with the automated header
 * (lib/internal/automated.ts), a peer's message is a custom entry, and
 * what a spawn tells a session first carries the header too, so a user
 * message without it is words a person wrote: typed in its window, or
 * said through the launcher's Steer. The cutover sends a driven session
 * to the attended host (host/cutover/attended.ts).
 */

import { isOthersSteerText } from "../../mesh/steer.ts";
import { isAutomatedText } from "../automated.ts";
import { isRecord } from "../record.ts";

/** A log entry's user message text, or nothing when it holds none. */
export function userTextOf(entry: unknown): string | undefined {
	if (!isRecord(entry) || entry.type !== "message") return undefined;
	const message = entry.message;
	if (!isRecord(message) || message.role !== "user") return undefined;
	const { content } = message;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	return content
		.map((part) =>
			isRecord(part) && typeof part.text === "string" ? part.text : "",
		)
		.join(" ");
}

/**
 * Whether text a session is given as a user's is a person's: anything
 * but what the harness says under its header, wherever it came from,
 * since the launcher's talks arrive through an extension and a client's
 * over RPC.
 */
export function isPersonText(text: string): boolean {
	return !isAutomatedText(text);
}

/**
 * Whether text a session is given as a user's is the person's own: a
 * person's, and no steer a peer agent or the machine wrote, which
 * reaches a session without the automated header too. A steer's frame
 * is declared by whoever wrote it, so this trusts the inbox's writers.
 */
export function isPersonsOwnText(text: string): boolean {
	return isPersonText(text) && !isOthersSteerText(text);
}

/** Whether a log entry is words a person wrote. */
export function isPersonWords(entry: unknown): boolean {
	const text = userTextOf(entry);
	return text !== undefined && isPersonText(text);
}
